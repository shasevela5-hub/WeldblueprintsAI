require("dotenv").config()

const express = require("express")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const session = require("express-session")
const FileStoreFactory = require("session-file-store")
const PDFDocument = require("pdfkit")

const app = express()
app.disable("x-powered-by")

const PORT = Number(process.env.PORT || 3000)
const NODE_ENV = process.env.NODE_ENV || "development"
const IS_PROD = NODE_ENV === "production"

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-me"
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me"
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!"
const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`
const SESSION_STORE = (process.env.SESSION_STORE || (IS_PROD ? "file" : "memory")).toLowerCase()
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || ""
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || ""
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com"
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@weldblueprints.ai"
const PRO_PRICE_USD = "19.99"
const FREE_GENERATION_LIMIT = Number(process.env.FREE_GENERATION_LIMIT || 3)

function normalizeOrigin(origin) {
  const raw = String(origin || "").trim()
  if (!raw) return ""
  try {
    return new URL(raw).origin.toLowerCase()
  } catch (_) {
    return raw.replace(/\/+$/, "").toLowerCase()
  }
}

function resolveStoragePath(envName, fallbackRelativePath) {
  const configured = String(process.env[envName] || "").trim()
  if (!configured) return path.resolve(__dirname, fallbackRelativePath)
  return path.resolve(configured)
}

const dataFile = resolveStoragePath("DATA_FILE", "data.json")
const backupDir = resolveStoragePath("BACKUP_DIR", "backups")
const analyticsFile = resolveStoragePath("ANALYTICS_FILE", "analytics.json")
const sessionDir = resolveStoragePath("SESSION_DIR", "sessions")

const appOriginNormalized = normalizeOrigin(APP_ORIGIN)
const allowedCorsOrigins = new Set([appOriginNormalized].filter(Boolean))

if (IS_PROD) {
  app.set("trust proxy", 1)
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    const normalized = normalizeOrigin(origin)
    if (allowedCorsOrigins.has(normalized)) return callback(null, true)
    return callback(null, false)
  },
  credentials: true
}))

app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "SAMEORIGIN")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  if (IS_PROD && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  }
  next()
})

app.use(express.json({ limit: "1mb" }))
app.use(express.urlencoded({ extended: true }))

function sendHtmlWithReplacements(res, fileName, replacements = {}) {
  try {
    const filePath = path.join(__dirname, fileName)
    let html = fs.readFileSync(filePath, "utf8")
    for (const [needle, value] of Object.entries(replacements)) {
      html = html.replaceAll(needle, value)
    }
    res.type("html").send(html)
  } catch (err) {
    console.error(`Failed to render ${fileName}:`, err.message)
    res.status(500).send("Page render failed")
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})
app.get("/pricing.html", (req, res) => {
  sendHtmlWithReplacements(res, "pricing.html", {
    "YOUR_PAYPAL_CLIENT_ID": PAYPAL_CLIENT_ID || ""
  })
})
app.get("/healthz", (req, res) => {
  res.json({ ok: true, env: NODE_ENV })
})

const blockedStaticExactPaths = new Set([
  "/data.json",
  "/analytics.json",
  "/server.js",
  "/package.json",
  "/package-lock.json",
  "/.env",
  "/.gitignore",
  "/readme.md"
])
const blockedStaticPrefixes = ["/backups/", "/sessions/", "/.git/"]
const allowedStaticExtensions = new Set([
  ".html", ".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".map", ".webmanifest", ".txt", ".xml"
])

function normalizeRequestPath(requestPath) {
  try {
    const decoded = decodeURIComponent(String(requestPath || "/"))
    const normalized = path.posix.normalize(decoded.startsWith("/") ? decoded : `/${decoded}`)
    return normalized.startsWith("/") ? normalized : `/${normalized}`
  } catch (_) {
    return null
  }
}

function isBlockedStaticPath(requestPath) {
  const normalized = normalizeRequestPath(requestPath)
  if (!normalized) return true
  const lower = normalized.toLowerCase()
  if (lower.includes("..")) return true
  if (blockedStaticExactPaths.has(lower)) return true
  if (blockedStaticPrefixes.some(prefix => lower.startsWith(prefix))) return true
  const ext = path.posix.extname(lower)
  if (ext && !allowedStaticExtensions.has(ext)) return true
  return false
}

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next()
  if (
    req.path.startsWith("/api/") ||
    req.path === "/generate-blueprint" ||
    req.path === "/health" ||
    req.path === "/healthz"
  ) {
    return next()
  }
  if (isBlockedStaticPath(req.path)) {
    return res.status(404).send("Not found")
  }
  next()
})

app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: false,
  fallthrough: true
}))

function buildSessionStore() {
  if (SESSION_STORE === "file") {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
    const FileStore = FileStoreFactory(session)
    return new FileStore({
      path: sessionDir,
      retries: 1,
      ttl: 7 * 24 * 60 * 60,
      reapInterval: 60 * 60
    })
  }
  return undefined
}

app.use(session({
  store: buildSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}))

const rateMap = new Map()

function rateLimit(keyPrefix, limit, windowMs) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip || "unknown"}`
    const now = Date.now()
    const entry = rateMap.get(key) || { count: 0, resetAt: now + windowMs }

    if (now > entry.resetAt) {
      entry.count = 0
      entry.resetAt = now + windowMs
    }

    entry.count += 1
    rateMap.set(key, entry)

    if (entry.count > limit) {
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many requests. Please try again in a moment."
      })
    }

    next()
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase()
}

function sameUserId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}

function findUserById(id) {
  return users.find(u => sameUserId(u.id, id))
}

function findUserFromToken(decoded) {
  if (!decoded || typeof decoded !== "object") return null
  const byId = findUserById(decoded.id)
  if (byId) return byId
  const email = normalizeEmail(decoded.email)
  if (!email) return null
  return users.find(u => normalizeEmail(u.email) === email) || null
}

function sanitizeText(value, max = 120) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max)
}

function sanitizeFilename(value) {
  return String(value || "blueprint")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "blueprint"
}

function parseDimensions(dimensions) {
  const cleaned = String(dimensions || "").trim().toLowerCase()
  const parts = cleaned.split("x").map(v => Number(v.trim()))
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v) || v <= 0 || v > 1000)) {
    return null
  }
  return { L: parts[0], W: parts[1], H: parts[2] }
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8
}

function isAllowedValue(value, allowed) {
  return allowed.includes(value)
}

function requireEnvForProd() {
  if (!IS_PROD) return
  const required = [
    "JWT_SECRET",
    "SESSION_SECRET",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "APP_ORIGIN"
  ]
  const missing = required.filter(name => !process.env[name])
  if (missing.length) {
    throw new Error(`Missing required production env vars: ${missing.join(", ")}`)
  }
}

function warnIfRiskyConfig() {
  const warnings = []

  if (!appOriginNormalized) {
    warnings.push("APP_ORIGIN is not a valid absolute URL. CORS may reject browser requests.")
  }
  if (JWT_SECRET === "dev-jwt-secret-change-me") {
    warnings.push("JWT_SECRET is using the development default.")
  }
  if (SESSION_SECRET === "dev-session-secret-change-me") {
    warnings.push("SESSION_SECRET is using the development default.")
  }
  if (ADMIN_PASSWORD === "ChangeThisAdminPassword123!") {
    warnings.push("ADMIN_PASSWORD is still the default value.")
  }
  if (IS_PROD && APP_ORIGIN.startsWith("http://")) {
    warnings.push("APP_ORIGIN uses http:// in production. Use https:// with your final domain.")
  }
  if (IS_PROD && /sandbox/i.test(PAYPAL_BASE_URL)) {
    warnings.push("PAYPAL_BASE_URL points to PayPal sandbox while NODE_ENV=production.")
  }

  warnings.forEach(message => {
    console.warn(`[startup warning] ${message}`)
  })
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

let users = []
let savedProjects = []
let savedSettings = []
let analytics = {
  totals: {},
  daily: {}
}
let lastAutosaveBackupAt = 0

function loadData() {
  try {
    if (!fs.existsSync(dataFile)) return
    const raw = fs.readFileSync(dataFile, "utf8")
    if (!raw.trim()) return
    const data = JSON.parse(raw)
    users = Array.isArray(data.users) ? data.users : []
    savedProjects = Array.isArray(data.savedProjects) ? data.savedProjects : []
    savedSettings = Array.isArray(data.savedSettings) ? data.savedSettings : []
    console.log(`Loaded ${path.basename(dataFile)}`)
  } catch (err) {
    console.error(`Failed to load ${path.basename(dataFile)}:`, err.message)
  }
}

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })
}

function timestampForFile(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const mi = String(date.getMinutes()).padStart(2, "0")
  const ss = String(date.getSeconds()).padStart(2, "0")
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function createDataBackup(reason = "manual") {
  try {
    ensureBackupDir()
    const safeReason = String(reason).replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "manual"
    const fileName = `data-${timestampForFile()}-${safeReason}.json`
    const backupPath = path.join(backupDir, fileName)
    if (fs.existsSync(dataFile)) {
      fs.copyFileSync(dataFile, backupPath)
    } else {
      const snapshot = { users, savedProjects, savedSettings }
      fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), "utf8")
    }

    const files = fs.readdirSync(backupDir)
      .filter(name => name.startsWith("data-") && name.endsWith(".json"))
      .sort()
    if (files.length > 30) {
      files.slice(0, files.length - 30).forEach(name => {
        try { fs.unlinkSync(path.join(backupDir, name)) } catch (_) {}
      })
    }
  } catch (err) {
    console.error("Backup error:", err.message)
  }
}

function loadAnalytics() {
  try {
    if (!fs.existsSync(analyticsFile)) return
    const raw = fs.readFileSync(analyticsFile, "utf8")
    if (!raw.trim()) return
    const parsed = JSON.parse(raw)
    analytics = {
      totals: parsed.totals && typeof parsed.totals === "object" ? parsed.totals : {},
      daily: parsed.daily && typeof parsed.daily === "object" ? parsed.daily : {}
    }
  } catch (err) {
    console.error(`Failed to load ${path.basename(analyticsFile)}:`, err.message)
  }
}

function saveAnalytics() {
  try {
    ensureParentDir(analyticsFile)
    fs.writeFileSync(analyticsFile, JSON.stringify(analytics, null, 2), "utf8")
  } catch (err) {
    console.error(`Failed to save ${path.basename(analyticsFile)}:`, err.message)
  }
}

function trackEvent(eventName) {
  const name = sanitizeText(eventName, 80).toLowerCase()
  if (!name) return
  const day = new Date().toISOString().slice(0, 10)
  analytics.totals[name] = (analytics.totals[name] || 0) + 1
  if (!analytics.daily[day]) analytics.daily[day] = {}
  analytics.daily[day][name] = (analytics.daily[day][name] || 0) + 1
  saveAnalytics()
}

function saveData(reason = "save") {
  const payload = { users, savedProjects, savedSettings }
  ensureParentDir(dataFile)
  fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), "utf8")
  const now = Date.now()
  if (reason === "critical" || now - lastAutosaveBackupAt > 15 * 60 * 1000) {
    createDataBackup(reason === "critical" ? "critical" : "autosave")
    lastAutosaveBackupAt = now
  }
}

async function ensureAdmin() {
  const existing = users.find(u => normalizeEmail(u.email) === ADMIN_EMAIL)
  if (existing) return
  const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10)
  users.push({
    id: Date.now(),
    username: "Admin",
    email: ADMIN_EMAIL,
    password: hashed,
    isAdmin: true,
    isPro: true,
    welderModel: "All",
    experience: "Expert",
    createdAt: new Date().toISOString(),
    generationsUsed: 0,
    savedProjects: [],
    savedSettings: [],
    favorites: []
  })
  saveData()
  console.log(`Admin account created: ${ADMIN_EMAIL}`)
}

function makeSafeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    welderModel: user.welderModel || "",
    experience: user.experience || "Beginner",
    isAdmin: !!user.isAdmin,
    isPro: !!user.isPro,
    generationsUsed: user.generationsUsed || 0,
    createdAt: user.createdAt
  }
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  )
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]
  if (!token) {
    return res.status(401).json({ error: "No token provided" })
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" })
    req.user = decoded
    req.userRecord = findUserFromToken(decoded)
    next()
  })
}

function tryAuthenticateToken(req) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]
  if (!token) return null

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    return findUserFromToken(decoded)
  } catch (_) {
    return null
  }
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]
  if (!token) return res.status(401).json({ error: "No token" })

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" })
    const user = findUserFromToken(decoded)
    if (!user || !user.isAdmin) return res.status(403).json({ error: "Admin only" })
    req.user = decoded
    next()
  })
}

const weldSettingsDB = {
  "Lincoln 210 MP": {
    manufacturer: "Lincoln",
    type: "Multi-Process",
    settings: {
      "MIG": {
        "1/8": { volts: "18.5", wireSpeed: "300", gas: "C25", technique: "Push 10deg", rating: 4.8, votes: 156 },
        "3/16": { volts: "19.5", wireSpeed: "330", gas: "C25", technique: "Push 10deg", rating: 4.9, votes: 203 },
        "1/4": { volts: "21.0", wireSpeed: "360", gas: "C25", technique: "Push 15deg", rating: 4.7, votes: 98 }
      },
      "Flux Core": {
        "1/8": { volts: "19.0", wireSpeed: "320", gas: "None", technique: "Drag 5deg", rating: 4.5, votes: 89 }
      }
    },
    tips: ["Use .030 wire for most work", "Keep gun cable straight"]
  },
  "Miller 211": {
    manufacturer: "Miller",
    type: "MIG",
    settings: {
      "MIG": {
        "1/8": { volts: "18.0", wireSpeed: "280", gas: "C25", technique: "Push 10deg", rating: 4.6, votes: 178 },
        "3/16": { volts: "19.0", wireSpeed: "310", gas: "C25", technique: "Push 10deg", rating: 4.8, votes: 234 }
      }
    },
    tips: ["Auto-set feature works well", "Popular home shop machine"]
  }
}

const blueprintGallery = {
  "Welding Cart": { category: "Shop Equipment", description: "Heavy-duty welding cart with bottle holder and tool tray", difficulty: "Beginner", time: "4-6 hours", image: "WC", defaultDims: "36x20x38" },
  "Shop Workbench": { category: "Shop Equipment", description: "8ft steel workbench with lower shelf", difficulty: "Intermediate", time: "6-8 hours", image: "WB", defaultDims: "96x30x36" },
  "Welding Table": { category: "Shop Equipment", description: "Flat welding table with fixture area", difficulty: "Intermediate", time: "8-10 hours", image: "WT", defaultDims: "48x30x34" },
  "Metal Shelving Unit": { category: "Shop Equipment", description: "Five-tier heavy-duty shelving", difficulty: "Beginner", time: "4-5 hours", image: "SU", defaultDims: "72x24x84" },
  "Tool Cabinet": { category: "Shop Equipment", description: "Steel tool cabinet with drawers", difficulty: "Advanced", time: "12-15 hours", image: "TC", defaultDims: "36x18x48" },
  "Band Saw Stand": { category: "Shop Equipment", description: "Adjustable stand for benchtop band saw", difficulty: "Beginner", time: "3-4 hours", image: "BS", defaultDims: "20x20x34" },
  "Plasma Cutter Cart": { category: "Shop Equipment", description: "Rolling cart with cable management", difficulty: "Beginner", time: "3-4 hours", image: "PC", defaultDims: "24x18x36" },
  "Angle Grinder Stand": { category: "Shop Equipment", description: "Compact pedestal stand for angle grinder", difficulty: "Beginner", time: "2-3 hours", image: "AG", defaultDims: "18x12x24" },
  "Drill Press Stand": { category: "Shop Equipment", description: "Rigid stand with lower shelf for drill press", difficulty: "Beginner", time: "3-4 hours", image: "DP", defaultDims: "24x20x34" },
  "Chop Saw Stand": { category: "Shop Equipment", description: "Portable saw stand with extension wings", difficulty: "Intermediate", time: "5-7 hours", image: "CS", defaultDims: "84x24x36" },
  "Material Rack": { category: "Shop Equipment", description: "Vertical steel stock storage rack", difficulty: "Intermediate", time: "4-6 hours", image: "MR", defaultDims: "48x24x72" },

  "Truck Flatbed": { category: "Truck & Trailers", description: "Steel flatbed with stake pockets", difficulty: "Advanced", time: "20-25 hours", image: "TF", defaultDims: "96x72x12" },
  "Utility Trailer": { category: "Truck & Trailers", description: "4x8 utility trailer with ramp gate", difficulty: "Advanced", time: "15-20 hours", image: "UT", defaultDims: "96x48x18" },
  "Headache Rack": { category: "Truck & Trailers", description: "Truck cab protector rack", difficulty: "Intermediate", time: "6-8 hours", image: "HR", defaultDims: "72x4x24" },
  "Truck Toolbox Rack": { category: "Truck & Trailers", description: "Over-bed rack with toolbox mounts", difficulty: "Intermediate", time: "8-10 hours", image: "TR", defaultDims: "72x60x36" },
  "Gooseneck Trailer": { category: "Truck & Trailers", description: "Equipment trailer with fold-down ramps", difficulty: "Advanced", time: "40-50 hours", image: "GT", defaultDims: "240x96x20" },
  "Pipe Rack": { category: "Truck & Trailers", description: "Truck bed pipe and lumber rack", difficulty: "Intermediate", time: "5-7 hours", image: "PR", defaultDims: "72x60x48" },
  "Enclosed Cargo Trailer Frame": { category: "Truck & Trailers", description: "Tube frame shell for enclosed trailer builds", difficulty: "Advanced", time: "30-35 hours", image: "EC", defaultDims: "144x72x72" },
  "Truck Bumper": { category: "Truck & Trailers", description: "Heavy-duty rear bumper with receiver and tabs", difficulty: "Intermediate", time: "8-10 hours", image: "TB", defaultDims: "72x8x12" },
  "Ladder Rack": { category: "Truck & Trailers", description: "Bed-mounted ladder rack with crossbars", difficulty: "Intermediate", time: "6-8 hours", image: "LR", defaultDims: "72x64x42" },
  "Receiver Hitch Carrier": { category: "Truck & Trailers", description: "2-inch hitch cargo carrier frame", difficulty: "Beginner", time: "3-4 hours", image: "HC", defaultDims: "60x24x8" },

  "Fire Pit": { category: "Outdoor & Garden", description: "Square fire pit with grate and rim", difficulty: "Beginner", time: "3-4 hours", image: "FP", defaultDims: "30x30x18" },
  "BBQ Grill": { category: "Outdoor & Garden", description: "Barrel-style grill with firebox", difficulty: "Intermediate", time: "10-14 hours", image: "BG", defaultDims: "60x24x48" },
  "Garden Gate": { category: "Outdoor & Garden", description: "Ornamental steel garden gate", difficulty: "Intermediate", time: "6-8 hours", image: "GG", defaultDims: "48x2x60" },
  "Outdoor Bench": { category: "Outdoor & Garden", description: "Steel-frame bench with wood slats", difficulty: "Beginner", time: "3-4 hours", image: "OB", defaultDims: "60x18x34" },
  "Raised Garden Bed": { category: "Outdoor & Garden", description: "Corten-style raised bed frame", difficulty: "Beginner", time: "2-3 hours", image: "RB", defaultDims: "72x36x18" },
  "Pergola Frame": { category: "Outdoor & Garden", description: "Steel pergola with post anchors", difficulty: "Advanced", time: "16-20 hours", image: "PF", defaultDims: "144x144x96" },
  "Planter Stand": { category: "Outdoor & Garden", description: "Tiered steel planter stand", difficulty: "Beginner", time: "2-3 hours", image: "PS", defaultDims: "24x12x48" },
  "Firewood Rack": { category: "Outdoor & Garden", description: "Covered firewood storage rack", difficulty: "Beginner", time: "2-4 hours", image: "FW", defaultDims: "48x16x48" },
  "Patio Table Base": { category: "Outdoor & Garden", description: "Steel outdoor dining table pedestal", difficulty: "Intermediate", time: "4-6 hours", image: "PT", defaultDims: "60x36x30" },
  "Trellis Panel": { category: "Outdoor & Garden", description: "Decorative steel climbing trellis", difficulty: "Beginner", time: "2-3 hours", image: "TP", defaultDims: "36x1x72" },
  "Smoker Trailer": { category: "Outdoor & Garden", description: "Towable smoker frame and chamber base", difficulty: "Advanced", time: "30-40 hours", image: "ST", defaultDims: "84x30x60" },

  "Carport Frame": { category: "Structural & Frames", description: "Steel carport frame with roof trusses", difficulty: "Advanced", time: "20-25 hours", image: "CF", defaultDims: "240x240x120" },
  "Greenhouse Frame": { category: "Structural & Frames", description: "Steel greenhouse frame", difficulty: "Advanced", time: "18-22 hours", image: "GF", defaultDims: "192x120x96" },
  "Stair Railing": { category: "Structural & Frames", description: "Code-compliant stair railing", difficulty: "Intermediate", time: "4-6 hours", image: "SR", defaultDims: "120x4x36" },
  "Mezzanine Frame": { category: "Structural & Frames", description: "Shop mezzanine platform frame", difficulty: "Advanced", time: "25-30 hours", image: "MF", defaultDims: "144x120x96" },
  "Engine Hoist": { category: "Structural & Frames", description: "2-ton folding hoist frame", difficulty: "Advanced", time: "12-15 hours", image: "EH", defaultDims: "60x36x72" },
  "ATV Roll Cage": { category: "Structural & Frames", description: "ROPS-style roll cage", difficulty: "Advanced", time: "15-18 hours", image: "RC", defaultDims: "60x48x60" },
  "Motorcycle Lift": { category: "Structural & Frames", description: "Scissor-style motorcycle lift frame", difficulty: "Advanced", time: "14-18 hours", image: "ML", defaultDims: "84x24x18" },
  "Shooting Bench": { category: "Structural & Frames", description: "Heavy bench frame with front support", difficulty: "Intermediate", time: "5-6 hours", image: "SB", defaultDims: "48x30x34" },
  "Pipe Handrail": { category: "Structural & Frames", description: "Industrial pipe handrail sections", difficulty: "Intermediate", time: "4-6 hours", image: "PH", defaultDims: "120x4x42" },
  "Gantry Crane": { category: "Structural & Frames", description: "Rolling A-frame gantry crane structure", difficulty: "Advanced", time: "18-24 hours", image: "GC", defaultDims: "120x48x96" },

  "Coffee Table": { category: "Home & Furniture", description: "Steel coffee table base", difficulty: "Beginner", time: "3-4 hours", image: "CT", defaultDims: "48x24x18" },
  "Bed Frame": { category: "Home & Furniture", description: "Queen-size steel bed frame", difficulty: "Intermediate", time: "8-10 hours", image: "BF", defaultDims: "80x60x48" },
  "Industrial Bookshelf": { category: "Home & Furniture", description: "Pipe-and-plate bookshelf frame", difficulty: "Beginner", time: "3-4 hours", image: "IB", defaultDims: "48x12x72" },
  "Dining Table Base": { category: "Home & Furniture", description: "Cross-style steel dining base", difficulty: "Intermediate", time: "5-6 hours", image: "DB", defaultDims: "60x28x30" },
  "Bar Stool": { category: "Home & Furniture", description: "Industrial steel bar stool", difficulty: "Intermediate", time: "4-5 hours", image: "BS", defaultDims: "16x16x30" },
  "Wine Rack": { category: "Home & Furniture", description: "Wall-mounted steel wine rack", difficulty: "Beginner", time: "2-3 hours", image: "WR", defaultDims: "36x8x24" },
  "Floating Wall Shelves": { category: "Home & Furniture", description: "Hidden-bracket steel shelf supports", difficulty: "Beginner", time: "2-3 hours", image: "FS", defaultDims: "36x10x4" },
  "Murphy Bed Frame": { category: "Home & Furniture", description: "Wall-folding bed support frame", difficulty: "Advanced", time: "12-14 hours", image: "MB", defaultDims: "54x8x78" },
  "Entry Console Table": { category: "Home & Furniture", description: "Slim steel console table frame", difficulty: "Beginner", time: "3-4 hours", image: "ET", defaultDims: "48x14x32" },
  "TV Stand Frame": { category: "Home & Furniture", description: "Low-profile media stand frame", difficulty: "Intermediate", time: "4-5 hours", image: "TV", defaultDims: "60x18x24" },

  "Steel Sign": { category: "Art & Decorative", description: "Custom plasma-cut sign with frame", difficulty: "Beginner", time: "2-3 hours", image: "SS", defaultDims: "24x2x12" },
  "Metal Wall Art": { category: "Art & Decorative", description: "Layered decorative wall panel", difficulty: "Intermediate", time: "5-7 hours", image: "WA", defaultDims: "36x2x36" },
  "Geometric Planter": { category: "Art & Decorative", description: "Faceted decorative planter", difficulty: "Intermediate", time: "4-5 hours", image: "GP", defaultDims: "16x16x18" },
  "Candle Holder": { category: "Art & Decorative", description: "Multi-arm candle holder", difficulty: "Beginner", time: "1-2 hours", image: "CH", defaultDims: "4x4x18" },
  "Steel Bookends": { category: "Art & Decorative", description: "Plate bookends with cutout details", difficulty: "Beginner", time: "1-2 hours", image: "BE", defaultDims: "6x4x8" },
  "Welded Sculpture": { category: "Art & Decorative", description: "Abstract welded sculpture", difficulty: "Advanced", time: "10-15 hours", image: "SC", defaultDims: "12x12x24" },
  "Custom Address Sign": { category: "Art & Decorative", description: "Decorative house number plate and frame", difficulty: "Beginner", time: "2-3 hours", image: "AS", defaultDims: "24x2x10" },
  "Metal Clock Frame": { category: "Art & Decorative", description: "Round steel wall clock frame", difficulty: "Beginner", time: "2-3 hours", image: "MC", defaultDims: "18x2x18" },
  "Decorative Screen Panel": { category: "Art & Decorative", description: "Laser/plasma style divider panel frame", difficulty: "Intermediate", time: "6-8 hours", image: "DS", defaultDims: "36x1x72" },
  "Welding Stool": { category: "Shop Equipment", description: "Heavy-duty rolling welding stool frame", difficulty: "Beginner", time: "2-3 hours", image: "WS", defaultDims: "16x16x20" },
  "Bottle Cart": { category: "Shop Equipment", description: "Single-cylinder gas bottle cart", difficulty: "Beginner", time: "2-3 hours", image: "BC", defaultDims: "20x16x42" },
  "Tube Bender Stand": { category: "Shop Equipment", description: "Rigid stand for manual tube bender", difficulty: "Intermediate", time: "3-4 hours", image: "TS", defaultDims: "24x24x36" },
  "Dump Trailer": { category: "Truck & Trailers", description: "Hydraulic dump trailer main frame", difficulty: "Advanced", time: "35-45 hours", image: "DT", defaultDims: "168x84x24" },
  "Skid Loader Attachment Frame": { category: "Truck & Trailers", description: "Quick-attach universal plate frame", difficulty: "Intermediate", time: "6-9 hours", image: "SL", defaultDims: "46x8x18" },
  "Trailer Spare Tire Mount": { category: "Truck & Trailers", description: "Bolt-on spare mount bracket assembly", difficulty: "Beginner", time: "1-2 hours", image: "SM", defaultDims: "14x6x18" },
  "Fence Panel": { category: "Outdoor & Garden", description: "Steel perimeter fence panel module", difficulty: "Beginner", time: "2-4 hours", image: "FN", defaultDims: "72x2x48" },
  "Arbor Arch": { category: "Outdoor & Garden", description: "Garden arbor with curved top arch", difficulty: "Intermediate", time: "6-8 hours", image: "AR", defaultDims: "72x24x96" },
  "Mailbox Post Frame": { category: "Outdoor & Garden", description: "Decorative steel mailbox support post", difficulty: "Beginner", time: "2-3 hours", image: "MP", defaultDims: "24x4x48" },
  "Shop Door Frame": { category: "Structural & Frames", description: "Tube-built man-door frame assembly", difficulty: "Intermediate", time: "3-5 hours", image: "DF", defaultDims: "42x4x84" },
  "Engine Stand": { category: "Structural & Frames", description: "Rotating engine stand frame", difficulty: "Intermediate", time: "4-6 hours", image: "ES", defaultDims: "36x28x60" },
  "Shelter Truss": { category: "Structural & Frames", description: "Welded roof truss segment for shelters", difficulty: "Advanced", time: "8-12 hours", image: "RT", defaultDims: "144x4x36" },
  "Console Desk Frame": { category: "Home & Furniture", description: "Slim steel desk frame with rear brace", difficulty: "Beginner", time: "3-4 hours", image: "CD", defaultDims: "48x20x30" },
  "Kitchen Island Base": { category: "Home & Furniture", description: "Tube base for butcher-block island top", difficulty: "Intermediate", time: "5-7 hours", image: "KI", defaultDims: "60x30x36" },
  "Entry Bench Frame": { category: "Home & Furniture", description: "Mudroom bench frame with shoe shelf", difficulty: "Beginner", time: "3-4 hours", image: "EB", defaultDims: "48x16x19" },
  "Monogram Wall Piece": { category: "Art & Decorative", description: "Custom letter monogram steel wall art", difficulty: "Beginner", time: "2-3 hours", image: "MW", defaultDims: "24x1x24" },
  "Hanging Pot Rack": { category: "Art & Decorative", description: "Ceiling-hung kitchen pot rack frame", difficulty: "Intermediate", time: "3-5 hours", image: "HP", defaultDims: "36x18x16" },
  "Decorative Candle Sconce": { category: "Art & Decorative", description: "Wall-mounted candle sconce set", difficulty: "Beginner", time: "1-2 hours", image: "DC", defaultDims: "6x4x18" }
}

function resolveProjectName(input) {
  const raw = sanitizeText(input, 120)
  if (!raw) return ""
  if (blueprintGallery[raw]) return raw

  const normalized = raw.toLowerCase()
  const match = Object.keys(blueprintGallery).find(name => name.toLowerCase() === normalized)
  return match || ""
}

function validateBlueprintCatalog() {
  const projects = Object.keys(blueprintGallery)
  const issues = []
  const styles = {}

  for (const name of projects) {
    const resolved = resolveProjectName(name)
    if (!resolved) {
      issues.push(`Unresolvable project name: ${name}`)
      continue
    }

    const dims = parseDimensions(blueprintGallery[name].defaultDims)
    if (!dims) {
      issues.push(`Invalid defaultDims for ${name}: ${blueprintGallery[name].defaultDims}`)
      continue
    }

    const style = getProjectStyle(name)
    styles[style] = (styles[style] || 0) + 1

    const data = defaultProjectData(name, dims.L, dims.W, dims.H)
    if (!data || !Array.isArray(data.parts) || data.parts.length < 1 || !Array.isArray(data.steps) || data.steps.length < 1) {
      issues.push(`Invalid blueprint data for ${name}`)
    }
  }

  return {
    total: projects.length,
    styles,
    issues
  }
}

function analyzeScrap(scrapList) {
  const suggestions = []
  const scrap = String(scrapList || "").toLowerCase()
  const hasTube = scrap.includes("tube") || scrap.includes("square") || scrap.includes("pipe")
  const hasPlate = scrap.includes("plate") || scrap.includes("sheet")
  const hasCasters = scrap.includes("caster") || scrap.includes("wheel")
  const hasRound = scrap.includes("round") || scrap.includes("rod") || scrap.includes("bar")
  const hasAngle = scrap.includes("angle") || scrap.includes("iron")
  const hasChannel = scrap.includes("channel") || scrap.includes("unistrut")

  if (hasTube && hasCasters) suggestions.push({ name: "Welding Cart", confidence: "95%", materials: "Tubing for frame and casters", image: "🛒", time: "4 hours" })
  if (hasTube && hasPlate) suggestions.push({ name: "Shop Workbench", confidence: "88%", materials: "Tube frame and plate top", image: "🔨", time: "6 hours" })
  if (hasPlate) suggestions.push({ name: "Fire Pit", confidence: "92%", materials: "Plate for sides", image: "🔥", time: "3 hours" })
  if (hasTube && hasAngle) suggestions.push({ name: "Metal Shelving Unit", confidence: "85%", materials: "Tube uprights and angle supports", image: "🗄️", time: "4 hours" })
  if (hasRound) suggestions.push({ name: "Planter Stand", confidence: "81%", materials: "Rod and tube stock", image: "🌿", time: "2 hours" })
  if (hasTube && hasChannel) suggestions.push({ name: "Welding Table", confidence: "82%", materials: "Tube frame and channel edging", image: "🗜️", time: "8 hours" })

  return suggestions.slice(0, 4)
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)))
}

function seedFromString(input) {
  let hash = 2166136261
  const text = String(input || "")
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function itemCodeFromIndex(index) {
  let value = Number(index) + 1
  let code = ""
  while (value > 0) {
    value -= 1
    code = String.fromCharCode(65 + (value % 26)) + code
    value = Math.floor(value / 26)
  }
  return code || "A"
}

function uniqueStrings(values, limit = Infinity) {
  const out = []
  const seen = new Set()
  values.forEach(value => {
    const clean = sanitizeText(value, 140)
    if (!clean) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(clean)
  })
  return out.slice(0, limit)
}

function buildProjectDetailProfile(project, style, L, W, H) {
  const lower = String(project || "").toLowerCase()
  const seed = seedFromString(`${project}|${style}|${L}|${W}|${H}`)
  const visual = {
    frontDivisions: clampNumber(2 + (seed % 3), 2, 5),
    sideDivisions: clampNumber(2 + ((seed >> 2) % 3), 2, 5),
    topGridCols: clampNumber(2 + ((seed >> 4) % 4), 2, 6),
    topGridRows: clampNumber(2 + ((seed >> 7) % 3), 2, 5),
    bracePattern: ["X", "V", "K", "none"][(seed >> 10) % 4],
    shelfBands: clampNumber((seed >> 12) % 3, 0, 3),
    centerOpening: false,
    archTop: false,
    wheelCount: 0,
    isoStruts: clampNumber(2 + ((seed >> 14) % 3), 2, 5)
  }

  const styleDefaults = {
    cart: { bracePattern: "X", shelfBands: 2, wheelCount: 4, topGridCols: 3, topGridRows: 2 },
    shelf: { bracePattern: "X", shelfBands: 2, topGridCols: 3, topGridRows: 3 },
    rack: { bracePattern: "K", shelfBands: 2, topGridCols: 4, topGridRows: 2 },
    trailer: { bracePattern: "X", wheelCount: 2, shelfBands: 1, topGridCols: 5, topGridRows: 2 },
    flatbed: { bracePattern: "X", wheelCount: 2, shelfBands: 1, topGridCols: 5, topGridRows: 2 },
    skid: { bracePattern: "K", shelfBands: 1, topGridCols: 4, topGridRows: 2 },
    hoist: { bracePattern: "V", wheelCount: 2, shelfBands: 0, topGridCols: 2, topGridRows: 2 },
    cage: { bracePattern: "X", archTop: true, shelfBands: 1, topGridCols: 3, topGridRows: 2 },
    lift: { bracePattern: "X", wheelCount: 2, shelfBands: 0, topGridCols: 3, topGridRows: 2 },
    gate: { bracePattern: "K", centerOpening: true, shelfBands: 0, topGridCols: 2, topGridRows: 2 },
    pit: { bracePattern: "none", shelfBands: 0, topGridCols: 3, topGridRows: 3 },
    greenhouse: { bracePattern: "K", archTop: true, shelfBands: 1, topGridCols: 4, topGridRows: 3 },
    pergola: { bracePattern: "V", shelfBands: 1, topGridCols: 4, topGridRows: 3 },
    carport: { bracePattern: "V", shelfBands: 1, topGridCols: 4, topGridRows: 3 },
    planter: { bracePattern: "none", centerOpening: true, shelfBands: 0, topGridCols: 3, topGridRows: 3 },
    furniture: { bracePattern: "K", shelfBands: 1, topGridCols: 3, topGridRows: 2 },
    decor: { bracePattern: "V", shelfBands: 0, topGridCols: 3, topGridRows: 3 },
    struct: { bracePattern: "K", shelfBands: 1, topGridCols: 4, topGridRows: 3 },
    frame: { bracePattern: "X", shelfBands: 1, topGridCols: 3, topGridRows: 2 }
  }
  if (styleDefaults[style]) {
    Object.assign(visual, styleDefaults[style])
  }

  const callouts = []
  const extraParts = []
  const extraSteps = []
  const materialHints = []
  const tags = []

  function addFeature(feature) {
    if (!feature) return
    if (feature.callout) callouts.push(feature.callout)
    if (feature.part) extraParts.push(feature.part)
    if (feature.step) extraSteps.push(feature.step)
    if (feature.materialHint) materialHints.push(feature.materialHint)
    if (feature.tag) tags.push(feature.tag)
  }

  if (lower.includes("drill")) {
    addFeature({
      callout: "Column centerline and base bolt pattern",
      part: { name: "Column mount plate", qty: 1, length: `${Math.max(10, Math.round(W * 0.7))}x${Math.max(10, Math.round(W * 0.7))}in`, material: "3/8 plate" },
      step: "Layout spindle centerline and bolt pattern before final welding.",
      materialHint: "column mount reinforcement",
      tag: "precision mounting"
    })
    visual.centerOpening = true
    visual.bracePattern = "K"
  }
  if (lower.includes("saw")) {
    addFeature({
      callout: "Blade travel clearance and work stop alignment",
      part: { name: "Tool deck plate", qty: 1, length: `${Math.max(14, Math.round(L * 0.45))}x${Math.max(10, Math.round(W * 0.5))}in`, material: "3/16 plate" },
      step: "Dry fit tool body and verify full blade travel before final welds.",
      materialHint: "tool deck reinforcement",
      tag: "tool envelope control"
    })
    visual.topGridRows = clampNumber(visual.topGridRows + 1, 2, 5)
  }
  if (lower.includes("grinder")) {
    addFeature({
      callout: "Spark guard and tool rest anchor points",
      part: { name: "Spark guard plate", qty: 1, length: "10x8in", material: "1/8 plate" },
      step: "Install spark guard tabs with operator clearance maintained.",
      materialHint: "spark shield plate",
      tag: "operator safety"
    })
    visual.bracePattern = "V"
  }
  if (lower.includes("bender")) {
    addFeature({
      callout: "Reaction arm and die mount centerline",
      part: { name: "Die mount doubler", qty: 1, length: "8x8in", material: "3/8 plate" },
      step: "Align die centerline to reaction arm before welding doublers.",
      materialHint: "die mount doubler",
      tag: "high load mounting"
    })
    visual.bracePattern = "K"
  }
  if (lower.includes("cart") || lower.includes("stool")) {
    addFeature({
      callout: "Caster spacing and center of gravity check",
      part: { name: "Caster cross brace", qty: 2, length: `${Math.max(10, Math.round(W * 0.8))}in`, material: "1x1 sq tube" },
      step: "Place casters to keep center of gravity inside wheel footprint.",
      materialHint: "caster gussets",
      tag: "mobility tuned"
    })
    visual.wheelCount = 4
  }
  if (lower.includes("trailer") || lower.includes("flatbed") || lower.includes("hitch")) {
    addFeature({
      callout: "Tongue datum and axle centerline control",
      part: { name: "Tongue gusset", qty: 2, length: "10in", material: "1/4 plate" },
      step: "Verify tongue centerline to axle offset before welding mounts.",
      materialHint: "tongue and axle gussets",
      tag: "road alignment"
    })
    visual.wheelCount = 2
    visual.topGridCols = clampNumber(visual.topGridCols + 1, 3, 6)
  }
  if (lower.includes("rack")) {
    addFeature({
      callout: "Load stop tabs and tie-down access",
      part: { name: "Tie-down tab", qty: 4, length: "3in", material: "1/4 plate" },
      step: "Add tie-down tabs at balanced load points on each side.",
      materialHint: "tie-down tabs",
      tag: "cargo retention"
    })
    visual.shelfBands = clampNumber(visual.shelfBands + 1, 1, 3)
  }
  if (lower.includes("gate") || lower.includes("door") || lower.includes("panel")) {
    addFeature({
      callout: "Latch-side reveal and hinge axis",
      part: { name: "Hinge backing plate", qty: 2, length: "6x3in", material: "3/16 plate" },
      step: "Set hinge axis straight and keep latch-side reveal uniform.",
      materialHint: "hinge reinforcement",
      tag: "swing fitment"
    })
    visual.centerOpening = true
  }
  if (lower.includes("fire") || lower.includes("grill") || lower.includes("smoker")) {
    addFeature({
      callout: "Heat zone separation and air control points",
      part: { name: "Air intake slider", qty: 2, length: "4x2in", material: "1/8 plate" },
      step: "Sequence welds to limit heat distortion around firebox seams.",
      materialHint: "high-temp plate details",
      tag: "thermal control"
    })
  }
  if (lower.includes("bench") || lower.includes("table") || lower.includes("desk")) {
    addFeature({
      callout: "Top mount tabs and anti-racking braces",
      part: { name: "Top mount tab", qty: 6, length: "2in", material: "3/16 plate" },
      step: "Install anti-racking braces before final top-tab welding.",
      materialHint: "top mounting tabs",
      tag: "surface alignment"
    })
    visual.bracePattern = visual.bracePattern === "none" ? "K" : visual.bracePattern
  }
  if (lower.includes("shelf") || lower.includes("cabinet") || lower.includes("bookshelf")) {
    addFeature({
      callout: "Shelf pitch and torsional bracing",
      part: { name: "Shelf support angle", qty: 4, length: `${Math.max(10, Math.round(W * 0.65))}in`, material: "1x1 angle" },
      step: "Hold shelf pitch consistent from base to top before weld-out.",
      materialHint: "shelf support angles",
      tag: "storage capacity"
    })
    visual.shelfBands = clampNumber(Math.max(2, visual.shelfBands), 1, 4)
  }
  if (lower.includes("hoist") || lower.includes("crane") || lower.includes("stand")) {
    addFeature({
      callout: "Load path from boom/mount into base",
      part: { name: "Load path gusset", qty: 2, length: "8in", material: "3/8 plate" },
      step: "Keep gusset orientation aligned with expected load path.",
      materialHint: "load path gussets",
      tag: "lift safety"
    })
  }
  if (lower.includes("cage")) {
    addFeature({
      callout: "Node triangulation and occupant clearance",
      part: { name: "Node gusset", qty: 8, length: "4in", material: "3/16 plate" },
      step: "Check occupant clearance envelope before closing node welds.",
      materialHint: "tube node gussets",
      tag: "impact structure"
    })
    visual.archTop = true
    visual.bracePattern = "X"
  }
  if (lower.includes("bed")) {
    addFeature({
      callout: "Mattress/deck support spacing and wall clearance",
      part: { name: "Deck support rail", qty: 3, length: `${Math.max(16, Math.round(W * 0.85))}in`, material: "1.5x1.5 sq tube" },
      step: "Verify deck support spacing matches panel or slat layout.",
      materialHint: "deck support rails",
      tag: "fit and comfort"
    })
  }
  if (lower.includes("planter") || lower.includes("garden") || lower.includes("mailbox")) {
    addFeature({
      callout: "Drainage and weather-exposed edge protection",
      part: { name: "Drain relief tab", qty: 4, length: "2in", material: "1/8 plate" },
      step: "Deburr drain and weather edges to prevent coating failure.",
      materialHint: "outdoor drain features",
      tag: "outdoor durability"
    })
  }
  if (lower.includes("sign") || lower.includes("art") || lower.includes("sculpture") || lower.includes("monogram")) {
    addFeature({
      callout: "Visual centerline and mount standoff balance",
      part: { name: "Hidden standoff tab", qty: 4, length: "2in", material: "3/16 plate" },
      step: "Balance standoff points to prevent wall twist after install.",
      materialHint: "display mounting tabs",
      tag: "visual balance"
    })
    visual.topGridRows = clampNumber(visual.topGridRows + 1, 2, 5)
  }

  if (!extraParts.length) {
    addFeature({
      callout: "Primary datum and assembly sequence marks",
      part: { name: "Fixture tab", qty: 4, length: "2in", material: "1/8 plate" },
      step: "Mark primary datum lines and keep fixtures in place through weld-out.",
      materialHint: "fixture tabs",
      tag: `${style} profile`
    })
  }

  const styleSummary = {
    cart: "mobile frame",
    shelf: "multi-level support",
    rack: "cargo rack geometry",
    trailer: "road-going frame",
    flatbed: "deck-frame load path",
    skid: "quick-attach interface",
    hoist: "lift structure",
    cage: "protective hoop geometry",
    lift: "pivoting lift linkage",
    gate: "swinging panel fitment",
    pit: "heat chamber form",
    greenhouse: "arched enclosure",
    pergola: "open-beam canopy",
    carport: "bay frame layout",
    planter: "drainage body",
    furniture: "finish-grade frame",
    decor: "display-focused profile",
    struct: "structural bracing",
    frame: "general fabrication frame"
  }
  if (styleSummary[style]) tags.unshift(styleSummary[style])

  return {
    visual,
    callouts: uniqueStrings(callouts, 4),
    extraParts: extraParts.slice(0, 2),
    extraSteps: uniqueStrings(extraSteps, 3),
    materialHints: uniqueStrings(materialHints, 2),
    featureSummary: uniqueStrings(tags, 3).join(" | ")
  }
}

function parseLengthInches(value) {
  const text = String(value || "").trim().toLowerCase()
  const match = text.match(/^(\d+(?:\.\d+)?)\s*in$/)
  if (!match) return null
  return Number(match[1])
}

function buildDerivedPartsFromVisual(style, visualProfile, L, W, H) {
  const derived = []
  const braceLength = Math.max(10, Math.round(Math.hypot(L * 0.35, H * 0.35)))

  if (visualProfile.frontDivisions > 2) {
    derived.push({
      name: "Front partition rib",
      qty: visualProfile.frontDivisions - 1,
      length: `${Math.max(10, Math.round(H * 0.7))}in`,
      material: "1x1 sq tube"
    })
  }

  if (visualProfile.topGridCols > 3) {
    derived.push({
      name: "Top grid crossmember",
      qty: visualProfile.topGridCols - 1,
      length: `${Math.max(10, Math.round(W * 0.9))}in`,
      material: "1x1 sq tube"
    })
  }

  if (visualProfile.shelfBands > 0) {
    derived.push({
      name: "Shelf support rail",
      qty: visualProfile.shelfBands * 2,
      length: `${Math.max(10, Math.round(L * 0.8))}in`,
      material: "1x1 sq tube"
    })
  }

  if (visualProfile.bracePattern !== "none") {
    derived.push({
      name: "Diagonal brace member",
      qty: visualProfile.bracePattern === "X" ? 4 : 2,
      length: `${braceLength}in`,
      material: "1x1 sq tube"
    })
  }

  if (visualProfile.wheelCount > 0 && style !== "trailer" && style !== "flatbed") {
    derived.push({
      name: "Wheel/caster mount plate",
      qty: visualProfile.wheelCount,
      length: "4x4in",
      material: "3/16 plate"
    })
  }

  if (visualProfile.centerOpening) {
    derived.push({
      name: "Opening trim frame",
      qty: 2,
      length: `${Math.max(8, Math.round(W * 0.45))}in`,
      material: "1x1 angle"
    })
  }

  if (visualProfile.archTop) {
    derived.push({
      name: "Arch cap segment",
      qty: 1,
      length: `${Math.max(12, Math.round(L * 0.55))}in`,
      material: "1in round tube"
    })
  }

  return derived.slice(0, 4)
}

function applyProjectDetailProfile(project, style, L, W, H, baseData) {
  const profile = buildProjectDetailProfile(project, style, L, W, H)
  const baseParts = Array.isArray(baseData.parts)
    ? baseData.parts.map(row => [
      String(row[0] || ""),
      sanitizeText(row[1], 64),
      row[2],
      sanitizeText(row[3], 32),
      sanitizeText(row[4], 40)
    ])
    : []

  const extraParts = profile.extraParts.map(part => [
    "",
    sanitizeText(part.name, 64),
    Math.max(1, Number(part.qty) || 1),
    sanitizeText(part.length, 32),
    sanitizeText(part.material, 40)
  ])
  const derivedParts = buildDerivedPartsFromVisual(style, profile.visual || {}, L, W, H).map(part => [
    "",
    sanitizeText(part.name, 64),
    Math.max(1, Number(part.qty) || 1),
    sanitizeText(part.length, 32),
    sanitizeText(part.material, 40)
  ])

  const seenPartKeys = new Set()
  const mergedParts = []
  ;[...baseParts, ...extraParts, ...derivedParts].forEach(part => {
    const key = `${part[1]}|${part[3]}|${part[4]}`.toLowerCase()
    if (seenPartKeys.has(key)) return
    seenPartKeys.add(key)
    mergedParts.push(part)
  })

  const parts = mergedParts.slice(0, 14).map((part, index) => [
    itemCodeFromIndex(index),
    part[1] || "Part",
    part[2] || 1,
    part[3] || "varies",
    part[4] || "steel"
  ])

  const stepValues = [
    ...(Array.isArray(baseData.steps) ? baseData.steps : []),
    ...profile.extraSteps
  ]
  const steps = uniqueStrings(stepValues, 12)

  const materialValues = uniqueStrings([
    baseData.material,
    ...profile.materialHints
  ], 2)
  const material = materialValues.join(" + ") || "2x2 sq tube and plate"

  return {
    material,
    parts,
    steps,
    callouts: profile.callouts,
    featureSummary: profile.featureSummary,
    visual: profile.visual
  }
}

function defaultProjectData(project, L, W, H) {
  const style = getProjectStyle(project)
  const map = {
    "Welding Cart": {
      material: "1x1 sq tube and 3/16 plate",
      parts: [
        ["A", "Top rail", 2, `${L}in`, "1x1 sq tube"],
        ["B", "Bottom rail", 2, `${L}in`, "1x1 sq tube"],
        ["C", "Side rail", 4, `${W}in`, "1x1 sq tube"],
        ["D", "Leg", 4, `${H}in`, "1x1 sq tube"],
        ["E", "Bottle upright", 2, "24in", "1x1 sq tube"],
        ["F", "Caster plate", 4, "4x4in", "3/16 plate"]
      ],
      steps: [
        "Cut all tube stock to length.",
        "Tack weld the top frame square on a flat surface.",
        "Add legs and check for square.",
        "Install lower rails and bottle supports.",
        "Weld caster plates and clean all joints.",
        "Prime and paint after final inspection."
      ]
    },
    "Welding Table": {
      material: "2x3 rect tube, 2x2 sq tube, 1/2 plate",
      parts: [
        ["A", "Long rail", 2, `${L}in`, "2x3 rect tube"],
        ["B", "Short rail", 3, `${W}in`, "2x3 rect tube"],
        ["C", "Leg", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Top plate", 1, `${L}x${W}in`, "1/2 plate"],
        ["E", "Caster mount", 4, "6in", "2x2 sq tube"],
        ["F", "Brace", 2, `${W}in`, "2x2 sq tube"]
      ],
      steps: [
        "Cut frame members and legs.",
        "Weld the frame and verify diagonal measurements.",
        "Install legs and braces.",
        "Set and weld top plate.",
        "Add caster mounts or feet.",
        "Clean the surface and protect exposed steel."
      ]
    },
    "Utility Trailer": {
      material: "3x2 rect tube, 2x2 sq tube, plate",
      parts: [
        ["A", "Main rail", 2, `${L}in`, "3x2 rect tube"],
        ["B", "Cross member", 3, `${W}in`, "2x2 sq tube"],
        ["C", "Tongue", 1, "48in", "3x2 rect tube"],
        ["D", "Side rail", 2, `${L}in`, "2x2 sq tube"],
        ["E", "Ramp frame", 2, `${W}in`, "2x2 sq tube"],
        ["F", "Axle mount", 2, `${W}in`, "3/16 plate"]
      ],
      steps: [
        "Build the main frame rectangle and check square.",
        "Weld the tongue and cross members.",
        "Add side rails and ramp framing.",
        "Install axle mounts and coupler.",
        "Check weld quality and alignment.",
        "Wire lights and apply finish."
      ]
    },
    "Carport Frame": {
      material: "4x4 post tube, 4x2 beam tube, 3/8 plate",
      parts: [
        ["A", "Main column", 4, `${H}in`, "4x4 sq tube"],
        ["B", "Roof beam", 2, `${L}in`, "4x2 rect tube"],
        ["C", "Roof purlin", 6, `${W}in`, "2x2 sq tube"],
        ["D", "Knee brace", 4, "24in", "2x2 sq tube"],
        ["E", "Base plate", 4, "10x10in", "3/8 plate"],
        ["F", "Ridge cap", 1, `${L}in`, "2x2 sq tube"]
      ],
      steps: [
        "Weld base plates to all columns.",
        "Set and plumb columns on anchors.",
        "Install roof beams at column tops.",
        "Add purlins and ridge member.",
        "Install knee braces and verify square.",
        "Final weld cleanup and corrosion protection."
      ]
    },
    "Greenhouse Frame": {
      material: "2x2 sq tube, 1x1 sq tube, bent round tube",
      parts: [
        ["A", "Base rail", 4, `${L}in`, "2x2 sq tube"],
        ["B", "Wall upright", 8, `${Math.round(H * 0.6)}in`, "1x1 sq tube"],
        ["C", "Roof arch", 6, `${W}in`, "1in round tube"],
        ["D", "Hip rafter", 2, `${L}in`, "1x1 sq tube"],
        ["E", "Glazing bar", 12, `${Math.round(L / 6)}in`, "1in flat bar"],
        ["F", "Door frame", 1, `${Math.round(W / 3)}x${Math.round(H * 0.6)}in`, "1x1 sq tube"]
      ],
      steps: [
        "Build base frame and verify level.",
        "Install uprights at equal spacing.",
        "Fit roof arches and hip rafters.",
        "Frame door opening and support bars.",
        "Weld all joints and check for rack.",
        "Prep for glazing panel installation."
      ]
    },
    "Stair Railing": {
      material: "1.5x1.5 rail tube, 2x2 post tube, 1/2 baluster",
      parts: [
        ["A", "Top rail", 1, `${L}in`, "1.5x1.5 sq tube"],
        ["B", "Bottom rail", 1, `${L}in`, "1.5x1.5 sq tube"],
        ["C", "Post", 3, `${H}in`, "2x2 sq tube"],
        ["D", "Baluster", 8, `${Math.max(18, H - 6)}in`, "1/2 sq bar"],
        ["E", "Base plate", 3, "4x4in", "3/16 plate"],
        ["F", "Post cap", 3, "2x2in", "3/16 plate"]
      ],
      steps: [
        "Cut rails, posts, and balusters.",
        "Weld base plates to posts.",
        "Set post locations and tack rails.",
        "Space and install balusters.",
        "Verify code spacing and height.",
        "Finish welds and apply coating."
      ]
    },
    "Mezzanine Frame": {
      material: "6x4 beam tube, 4x2 joist tube, 4x4 column tube",
      parts: [
        ["A", "Main beam", 3, `${L}in`, "6x4 rect tube"],
        ["B", "Floor joist", 6, `${W}in`, "4x2 rect tube"],
        ["C", "Column", 4, `${H}in`, "4x4 sq tube"],
        ["D", "Beam bracket", 6, "8x6in", "3/8 plate"],
        ["E", "Base plate", 4, "12x12in", "1/2 plate"],
        ["F", "Safety post", 8, "42in", "2x2 sq tube"]
      ],
      steps: [
        "Prepare column base assemblies.",
        "Stand and anchor columns plumb.",
        "Install primary beams and brackets.",
        "Set floor joists and verify level.",
        "Add perimeter safety posts/rails.",
        "Finalize welds and surface prep."
      ]
    },
    "Engine Hoist": {
      material: "3x3 base tube, 4x4 mast tube, 3/8 gusset plate",
      parts: [
        ["A", "Base beam long", 2, `${L}in`, "3x3 sq tube"],
        ["B", "Base beam cross", 1, `${W}in`, "3x3 sq tube"],
        ["C", "Vertical mast", 1, `${H}in`, "4x4 sq tube"],
        ["D", "Boom arm", 1, `${Math.round(L * 0.6)}in`, "3x3 sq tube"],
        ["E", "Gusset plate", 4, "8x8in", "3/8 plate"],
        ["F", "Caster mount", 4, "6in", "3x3 sq tube"]
      ],
      steps: [
        "Build H-base and verify symmetry.",
        "Install mast and heavy gussets.",
        "Fabricate boom arm with adjustment holes.",
        "Fit pivot and lock hardware.",
        "Install caster mounts and wheels.",
        "Load test and inspect weld integrity."
      ]
    },
    "ATV Roll Cage": {
      material: "1.75 DOM tube and 3/16 gusset plate",
      parts: [
        ["A", "Main hoop", 1, `${H}x${W}in`, "1.75 DOM"],
        ["B", "Front hoop", 1, `${H}x${Math.round(W / 1.5)}in`, "1.75 DOM"],
        ["C", "Roof bar", 2, `${Math.round(L * 0.5)}in`, "1.75 DOM"],
        ["D", "Side bar", 2, `${Math.round(L * 0.5)}in`, "1.75 DOM"],
        ["E", "Gusset", 8, "4in", "3/16 plate"],
        ["F", "Mount plate", 4, "6x4in", "3/16 plate"]
      ],
      steps: [
        "Bend and notch all tube members.",
        "Tack cage on vehicle with clearances.",
        "Verify symmetry and driver clearance.",
        "Fully weld joints and install gussets.",
        "Fit mount plates and hardware.",
        "Final inspection and finish coating."
      ]
    },
    "Shop Workbench": {
      material: "2x2 sq tube and 3/16 top plate",
      parts: [
        ["A", "Long rail", 2, `${L}in`, "2x2 sq tube"],
        ["B", "Short rail", 3, `${W}in`, "2x2 sq tube"],
        ["C", "Leg", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Lower rail", 2, `${L}in`, "2x2 sq tube"],
        ["E", "Shelf cross", 2, `${W}in`, "2x2 sq tube"],
        ["F", "Top plate", 1, `${L}x${W}in`, "3/16 plate"]
      ],
      steps: ["Cut frame members.", "Build top rectangle and square it.", "Install legs and lower frame.", "Fit top plate.", "Add shelf braces.", "Clean, prime, and paint."]
    },
    "Metal Shelving Unit": {
      material: "1x1 sq tube and 16ga sheet",
      parts: [
        ["A", "Upright", 4, `${H}in`, "1x1 sq tube"],
        ["B", "Shelf long", 10, `${L}in`, "1x1 sq tube"],
        ["C", "Shelf short", 10, `${W}in`, "1x1 sq tube"],
        ["D", "Shelf panel", 5, `${L}x${W}in`, "16ga sheet"],
        ["E", "Brace", 4, "24in", "1x1 sq tube"],
        ["F", "Base plate", 4, "4x4in", "3/16 plate"]
      ],
      steps: ["Cut uprights and shelf rails.", "Build shelf frames.", "Set shelf heights and tack.", "Add panels and braces.", "Verify plumb/square.", "Final weld and finish."]
    },
    "Truck Flatbed": {
      material: "3x2 rect tube, 2x2 crossmembers, 3/16 plate",
      parts: [
        ["A", "Main rail", 2, `${L}in`, "3x2 rect tube"],
        ["B", "Crossmember", 6, `${W}in`, "2x2 sq tube"],
        ["C", "Perimeter rail", 2, `${L}in`, "2x2 sq tube"],
        ["D", "Headache uprights", 2, "36in", "2x2 sq tube"],
        ["E", "Stake pocket", 6, "4in", "2x3 rect tube"],
        ["F", "Deck plate", 1, `${L}x${W}in`, "3/16 plate"]
      ],
      steps: ["Layout main frame.", "Install crossmembers evenly.", "Add perimeter rails and stake pockets.", "Fit headache rack.", "Weld deck plate.", "Prep and coat."]
    },
    "Headache Rack": {
      material: "2x2 sq tube with 3/16 mounting plates",
      parts: [
        ["A", "Top rail", 1, `${L}in`, "2x2 sq tube"],
        ["B", "Bottom rail", 1, `${L}in`, "2x2 sq tube"],
        ["C", "Upright", 2, `${H}in`, "2x2 sq tube"],
        ["D", "Diagonal brace", 2, `${Math.round(H * 0.9)}in`, "1x1 sq tube"],
        ["E", "Light bar rail", 1, `${L}in`, "1x1 sq tube"],
        ["F", "Mount plate", 4, "6x4in", "3/16 plate"]
      ],
      steps: ["Cut and prep all tube.", "Assemble outer frame square.", "Add diagonals and top accessory rail.", "Fit mount plates.", "Test fit on truck.", "Finish coat."]
    },
    "Gooseneck Trailer": {
      material: "6x4 rect tube, 3x2 cross tube, 3/16 gusset",
      parts: [
        ["A", "Main beam", 2, `${L}in`, "6x4 rect tube"],
        ["B", "Crossmember", 8, `${W}in`, "3x2 rect tube"],
        ["C", "Neck beam", 2, "60in", "6x4 rect tube"],
        ["D", "Neck brace", 4, "36in", "3x2 rect tube"],
        ["E", "Ramp frame", 2, `${W}in`, "2x2 sq tube"],
        ["F", "Stake pocket", 8, "5in", "2x3 rect tube"]
      ],
      steps: ["Build bed frame and verify square.", "Assemble neck and gusset heavily.", "Install crossmembers and pockets.", "Build rear ramps.", "Add axle mounts and coupler.", "Finalize welds and paint."]
    },
    "Enclosed Cargo Trailer Frame": {
      material: "2x3 and 2x2 tube frame members",
      parts: [
        ["A", "Lower rail", 2, `${L}in`, "2x3 rect tube"],
        ["B", "Floor cross", 6, `${W}in`, "2x2 sq tube"],
        ["C", "Corner upright", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Wall upright", 6, `${H}in`, "1.5x1.5 sq tube"],
        ["E", "Roof bow", 4, `${W}in`, "1.5x1.5 sq tube"],
        ["F", "Door frame", 1, `${W}x${H}in`, "1.5x1.5 sq tube"]
      ],
      steps: ["Build floor perimeter.", "Install uprights and check plumb.", "Tie walls with top rails and bows.", "Frame rear door opening.", "Check for racking.", "Weld out and prep."]
    },
    "Truck Bumper": {
      material: "3x4 bumper tube and 3/8 mounting plates",
      parts: [
        ["A", "Bumper tube", 1, `${L}in`, "3x4 rect tube"],
        ["B", "Mount plate", 2, "12x8in", "3/8 plate"],
        ["C", "D-ring tab", 2, "6x4in", "3/8 plate"],
        ["D", "Receiver tube", 1, "12in", "2in sq tube"],
        ["E", "Gusset", 4, "6in", "3/16 plate"],
        ["F", "Sensor cap", 2, "3in", "16ga sheet"]
      ],
      steps: ["Cut main tube and plate.", "Install mount plates square.", "Add receiver and tabs.", "Gusset all load points.", "Check fit on frame.", "Dress welds and coat."]
    },
    "Pipe Rack": {
      material: "2x2 sq tube with round stanchion tube",
      parts: [
        ["A", "Upright", 4, `${H}in`, "2x2 sq tube"],
        ["B", "Bed rail", 2, `${L}in`, "2x2 sq tube"],
        ["C", "Crossbar", 3, `${W}in`, "2x2 sq tube"],
        ["D", "Stanchion", 4, "36in", "1.5 round tube"],
        ["E", "Stake insert", 4, "6in", "1.5 sq tube"],
        ["F", "Pipe stop", 8, "3in", "1 round rod"]
      ],
      steps: ["Build side frames.", "Connect with crossbars.", "Install stanchions and stops.", "Fit stake inserts.", "Test fit in bed.", "Prime and paint."]
    },
    "Skid Loader Attachment Frame": {
      material: "5/16 quick-attach plate, 3x3 tube crossmembers, and 3/8 pin ears",
      parts: [
        ["A", "Quick-attach top rail", 1, `${L}in`, "5/16 plate"],
        ["B", "Quick-attach bottom rail", 1, `${L}in`, "5/16 plate"],
        ["C", "Center support plate", 1, `${Math.max(12, Math.round(H * 0.8))}in`, "5/16 plate"],
        ["D", "Rear cross tube", 2, `${Math.max(18, Math.round(L * 0.55))}in`, "3x3 sq tube"],
        ["E", "Pin ear pair", 2, "8x4in", "3/8 plate"],
        ["F", "Latch tab pair", 2, "6x3in", "3/8 plate"]
      ],
      steps: [
        "Cut and bevel quick-attach plate profile.",
        "Fit top and bottom rails to OEM quick-attach spacing.",
        "Install center support and rear cross tubes square.",
        "Weld pin ears and latch tabs to machine-side spec.",
        "Check coupler fit on skid loader before finish welding.",
        "Final weld, stress-relief cool-down, and corrosion coating."
      ]
    },
    "Fire Pit": {
      material: "3/16 plate and 1x1 angle rim",
      parts: [
        ["A", "Side panel", 4, `${W}x${H}in`, "3/16 plate"],
        ["B", "Bottom plate", 1, `${W}x${W}in`, "3/16 plate"],
        ["C", "Leg", 4, "6in", "2x2 sq tube"],
        ["D", "Grate bar", 6, `${Math.max(8, W - 2)}in`, "1/2 round rod"],
        ["E", "Top rim", 4, `${W}in`, "1x1 angle"],
        ["F", "Ash door", 1, "4x4in", "3/16 plate"]
      ],
      steps: ["Cut panels and bottom.", "Tack box and verify square.", "Weld seams.", "Install grate and rim.", "Add legs and ash access.", "Grind edges and high-temp coat."]
    },
    "BBQ Grill": {
      material: "3/16 plate body with pipe stack",
      parts: [
        ["A", "Body shell", 1, `${L}x${W}in`, "3/16 plate"],
        ["B", "End cap", 2, `${W}in dia`, "3/16 plate"],
        ["C", "Firebox", 1, "16x16x16in", "3/16 plate"],
        ["D", "Leg", 4, `${Math.max(20, H - 24)}in`, "2x2 sq tube"],
        ["E", "Cooking grate", 2, `${Math.max(24, L - 4)}in`, "1/2 round rod"],
        ["F", "Smoke stack", 1, "6x12in", "pipe"]
      ],
      steps: ["Roll and weld body shell.", "Install end caps and lid hinge.", "Build and attach firebox.", "Add legs and shelf supports.", "Fit grates and stack.", "Coat with high-temp paint."]
    },
    "Garden Gate": {
      material: "1x2 flat bar frame and 1/2 pickets",
      parts: [
        ["A", "Stile", 2, `${H}in`, "1x2 flat bar"],
        ["B", "Rail", 2, `${W}in`, "1x2 flat bar"],
        ["C", "Picket", 7, `${Math.max(18, H - 4)}in`, "1/2 sq bar"],
        ["D", "Diagonal brace", 1, `${Math.max(W, H)}in`, "1/2 flat bar"],
        ["E", "Hinge", 2, "5in", "weld-on hinge"],
        ["F", "Latch", 1, "std", "gate latch"]
      ],
      steps: ["Build perimeter frame square.", "Install pickets with equal spacing.", "Add diagonal brace.", "Weld hinge tabs.", "Test swing and latch.", "Finish coat."]
    },
    "Outdoor Bench": {
      material: "1.5x1.5 and 1x1 tube with seat tabs",
      parts: [
        ["A", "Leg", 4, `${H}in`, "1.5x1.5 sq tube"],
        ["B", "Seat rail", 2, `${L}in`, "1x1 sq tube"],
        ["C", "Cross rail", 3, `${W}in`, "1x1 sq tube"],
        ["D", "Back upright", 2, `${Math.round(H * 0.45)}in`, "1x1 sq tube"],
        ["E", "Back rail", 1, `${L}in`, "1x1 sq tube"],
        ["F", "Seat tab", 8, "3in", "3/16 plate"]
      ],
      steps: ["Build side assemblies.", "Join with seat rails.", "Add back uprights/rail.", "Weld seat tabs.", "Check level and stability.", "Paint then install slats."]
    },
    "Raised Garden Bed": {
      material: "3/16 plate with corner posts",
      parts: [
        ["A", "Long wall", 2, `${L}x${H}in`, "3/16 plate"],
        ["B", "Short wall", 2, `${W}x${H}in`, "3/16 plate"],
        ["C", "Corner post", 4, `${H + 2}in`, "1.5x1.5 sq tube"],
        ["D", "Top cap long", 2, `${L}in`, "1x2 flat bar"],
        ["E", "Top cap short", 2, `${W}in`, "1x2 flat bar"],
        ["F", "Drain strip", 2, `${L}in`, "1x1 angle"]
      ],
      steps: ["Cut all panels.", "Tack walls to posts.", "Weld inside seams.", "Install top caps.", "Add drain strips/holes.", "Deburr and set in place."]
    },
    "Pergola Frame": {
      material: "4x4 posts with 4x2 beams and 2x2 rafters",
      parts: [
        ["A", "Post", 4, `${H}in`, "4x4 sq tube"],
        ["B", "Beam", 2, `${L}in`, "4x2 rect tube"],
        ["C", "Rafter", 6, `${W}in`, "2x2 sq tube"],
        ["D", "Base plate", 4, "8x8in", "3/8 plate"],
        ["E", "Knee brace", 4, "24in", "2x2 sq tube"],
        ["F", "Rafter tie", 12, "3in", "3/16 plate"]
      ],
      steps: ["Prep posts and base plates.", "Set posts plumb.", "Install beams and braces.", "Place rafters evenly.", "Tie each rafter connection.", "Final weld and protective coating."]
    },
    "Planter Stand": {
      material: "1x1 tube with round-rod shelf bars",
      parts: [
        ["A", "Leg", 4, `${H}in`, "1x1 sq tube"],
        ["B", "Shelf long", 6, `${L}in`, "1x1 sq tube"],
        ["C", "Shelf short", 6, `${W}in`, "1x1 sq tube"],
        ["D", "Grate bar", 12, `${W}in`, "1/4 round rod"],
        ["E", "Brace", 4, "14in", "1x1 sq tube"],
        ["F", "Pot ring", 3, `${W}in dia`, "3/16 flat bar"]
      ],
      steps: ["Build shelf rectangles.", "Attach shelves to legs.", "Add grate bars and braces.", "Fit pot rings.", "Check for wobble.", "Grind and finish."]
    },
    "Floating Wall Shelves": {
      material: "3/8 plate brackets with hidden rods",
      parts: [
        ["A", "Bracket arm", 3, "12in", "3/8 plate"],
        ["B", "Wall plate", 3, "6x4in", "3/16 plate"],
        ["C", "Stiffener", 3, "8in", "3/16 plate"],
        ["D", "Shelf rod", 6, `${Math.max(8, Math.round(L / 3))}in`, "round bar"],
        ["E", "End cap", 6, "2in", "3/16 plate"],
        ["F", "Set screw tab", 3, "1in", "1/8 flat bar"]
      ],
      steps: ["Fabricate hidden brackets.", "Drill wall mounting holes.", "Install into studs level.", "Slide shelves onto rods.", "Lock with set screws.", "Touch up finish."]
    },
    "Murphy Bed Frame": {
      material: "2x3 and 2x2 tube with pivot plates",
      parts: [
        ["A", "Wall frame upright", 4, `${H}in`, "2x3 rect tube"],
        ["B", "Wall frame rail", 4, `${W}in`, "2x3 rect tube"],
        ["C", "Bed side rail", 2, `${L}in`, "2x2 sq tube"],
        ["D", "Bed cross rail", 3, `${W}in`, "2x2 sq tube"],
        ["E", "Pivot arm", 2, "24in", "2x2 sq tube"],
        ["F", "Pivot plate", 4, "6x4in", "3/8 plate"]
      ],
      steps: ["Build wall anchor frame.", "Build bed platform frame.", "Install pivot plates and arms.", "Mount frame to wall studs.", "Test fold action and clearances.", "Install hardware and finish."]
    },
    "Motorcycle Lift": {
      material: "2x3 and 2x2 tube with pivot pins",
      parts: [
        ["A", "Top frame long", 2, `${L}in`, "2x3 rect tube"],
        ["B", "Top frame cross", 3, `${W}in`, "2x2 sq tube"],
        ["C", "Scissor arm", 4, `${Math.round(L * 0.6)}in`, "2x2 sq tube"],
        ["D", "Pivot pin", 4, `${W}in`, "1in round bar"],
        ["E", "Deck plate", 1, `${L}x${W}in`, "3/16 plate"],
        ["F", "Cylinder mount", 2, "6x4in", "3/8 plate"]
      ],
      steps: ["Build top/bottom frames.", "Drill and fit scissor arms.", "Install pivot pins.", "Fit cylinder mounts.", "Install deck and chock.", "Cycle test and finish."]
    },
    "Shooting Bench": {
      material: "2x2 and 1.5x1.5 tube with plate top",
      parts: [
        ["A", "Leg", 3, `${H}in`, "2x2 sq tube"],
        ["B", "Top long", 2, `${L}in`, "1.5x1.5 sq tube"],
        ["C", "Top cross", 2, `${W}in`, "1.5x1.5 sq tube"],
        ["D", "Front rest rail", 1, `${W}in`, "1.5x1.5 sq tube"],
        ["E", "Brace", 2, `${L}in`, "1x1 sq tube"],
        ["F", "Top plate", 1, `${L}x${W}in`, "3/16 plate"]
      ],
      steps: ["Assemble top frame.", "Install tripod leg layout.", "Add braces and front rest.", "Fit top plate.", "Level bench and verify stability.", "Prime and paint."]
    }
  }

  if (map[project]) {
    return applyProjectDetailProfile(project, style, L, W, H, map[project])
  }

  const styleTemplate = buildStyleTemplate(project, style, L, W, H)
  if (styleTemplate) {
    return applyProjectDetailProfile(project, style, L, W, H, styleTemplate)
  }

  const category = blueprintGallery[project] && blueprintGallery[project].category

  const templates = {
    "Shop Equipment": {
      material: "2x2 sq tube and 3/16 plate",
      parts: [
        ["A", "Main rail", 2, `${L}in`, "2x2 sq tube"],
        ["B", "Cross member", 3, `${W}in`, "2x2 sq tube"],
        ["C", "Leg", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Shelf rail", 2, `${L}in`, "1x1 sq tube"],
        ["E", "Top plate", 1, `${L}x${W}in`, "3/16 plate"],
        ["F", "Foot/caster plate", 4, "4x4in", "3/16 plate"]
      ],
      steps: [
        "Cut frame members and legs to length.",
        "Tack main frame square on a flat surface.",
        "Install legs and verify diagonal alignment.",
        "Add shelf rails and support pieces.",
        "Fit top plate and complete welds.",
        "Clean, prep, and coat all exposed metal."
      ]
    },
    "Truck & Trailers": {
      material: "3x2 rect tube, 2x2 sq tube, and plate",
      parts: [
        ["A", "Main frame rail", 2, `${L}in`, "3x2 rect tube"],
        ["B", "Cross member", 4, `${W}in`, "2x2 sq tube"],
        ["C", "Upright/support", 2, `${Math.max(24, Math.round(H * 0.5))}in`, "2x2 sq tube"],
        ["D", "Side rail", 2, `${L}in`, "2x2 sq tube"],
        ["E", "Mount plate", 4, "6x4in", "3/16 plate"],
        ["F", "Gusset", 6, "6in", "3/16 plate"]
      ],
      steps: [
        "Layout and tack the main rectangular frame.",
        "Install cross members with equal spacing.",
        "Fit tongue, supports, or rack uprights as required.",
        "Weld side rails and mount plates.",
        "Add gussets at high-load joints.",
        "Verify alignment, then finish and paint."
      ]
    },
    "Outdoor & Garden": {
      material: "3/16 plate and 1x1 to 2x2 tube",
      parts: [
        ["A", "Body/frame side", 2, `${L}in`, "1x1 or 2x2 tube"],
        ["B", "Body/frame end", 2, `${W}in`, "1x1 or 2x2 tube"],
        ["C", "Vertical support", 4, `${H}in`, "1x1 or 2x2 tube"],
        ["D", "Panel/plate", 2, `${L}x${H}in`, "3/16 plate"],
        ["E", "Panel/plate", 2, `${W}x${H}in`, "3/16 plate"],
        ["F", "Trim/rim", 4, `${W}in`, "flat bar or angle"]
      ],
      steps: [
        "Cut frame and panel pieces to size.",
        "Tack frame and check overall square.",
        "Install side and end panels.",
        "Add trim, rim, or decorative features.",
        "Complete welds and smooth exposed joints.",
        "Apply high-temp paint or outdoor finish."
      ]
    },
    "Home & Furniture": {
      material: "1x1 to 2x2 tube and plate tabs",
      parts: [
        ["A", "Long rail", 2, `${L}in`, "1x1 or 2x2 tube"],
        ["B", "Short rail", 2, `${W}in`, "1x1 or 2x2 tube"],
        ["C", "Leg/support", 4, `${H}in`, "1x1 or 2x2 tube"],
        ["D", "Cross brace", 2, `${Math.max(12, Math.round(L * 0.35))}in`, "1x1 tube"],
        ["E", "Mount tab", 4, "3in", "3/16 plate"],
        ["F", "Leveling foot", 4, "1in", "rubber or threaded"]
      ],
      steps: [
        "Cut rails and support members.",
        "Tack frame and verify level and square.",
        "Install legs and braces.",
        "Add mount tabs or hardware points.",
        "Dress welds where visible.",
        "Apply finish and install top/surfaces."
      ]
    },
    "Art & Decorative": {
      material: "14ga to 3/16 plate and light tube",
      parts: [
        ["A", "Base plate", 1, `${Math.max(12, Math.round(W * 0.8))}x${Math.max(12, Math.round(W * 0.8))}in`, "3/16 plate"],
        ["B", "Main form", 1, `${L}x${H}in`, "14ga or 3/16 plate"],
        ["C", "Support rod", 2, `${H}in`, "round rod"],
        ["D", "Detail element", 4, "varies", "scrap steel"],
        ["E", "Mount tab", 2, "3in", "3/16 plate"],
        ["F", "Trim piece", 4, "varies", "flat bar"]
      ],
      steps: [
        "Cut base and primary shape pieces.",
        "Tack main form to support structure.",
        "Add decorative and detail elements.",
        "Check visual alignment from all angles.",
        "Complete final welds and blend edges.",
        "Apply patina, paint, or clear finish."
      ]
    }
  }

  const keywordProfiles = [
    {
      match: ["stand"],
      material: "2x2 sq tube, plate tabs, and gussets",
      partName: ["Base rail", "Top rail", "Upright", "Brace", "Mount plate", "Foot plate"],
      steps: [
        "Build the base and top support frames.",
        "Install uprights and maintain plumb alignment.",
        "Add braces and all mounting tabs.",
        "Check footprint stability and height.",
        "Complete welds and blend exposed edges.",
        "Prime and apply durable shop finish."
      ]
    },
    {
      match: ["rack"],
      material: "2x2 sq tube, 1.5 round tube, and plate mounts",
      partName: ["Side rail", "Cross rail", "Upright", "Stanchion", "Mount insert", "Stop tab"],
      steps: [
        "Build side rail assemblies to equal length.",
        "Install cross rails and verify spacing.",
        "Add uprights and stanchion features.",
        "Fit mount inserts and retention tabs.",
        "Test fit to host platform or wall.",
        "Final weld cleanup and corrosion protection."
      ]
    },
    {
      match: ["bench", "table", "desk"],
      material: "2x2 sq tube, 1x1 braces, and top tabs",
      partName: ["Long rail", "Short rail", "Leg", "Cross brace", "Mount tab", "Level foot"],
      steps: [
        "Assemble top frame and verify square.",
        "Install leg set and lower stretcher.",
        "Add cross braces for torsional rigidity.",
        "Weld top tabs and hardware points.",
        "Dress visible welds and verify level.",
        "Apply finish and mount top surface."
      ]
    },
    {
      match: ["trailer", "flatbed", "hitch", "carrier"],
      material: "3x2 and 2x2 tube with plate mounts",
      partName: ["Main rail", "Crossmember", "Support upright", "Side rail", "Mount plate", "Gusset"],
      steps: [
        "Lay out and tack the base frame.",
        "Install crossmembers at equal intervals.",
        "Add support uprights and side rails.",
        "Fit all plate mounts and coupler points.",
        "Gusset high-load nodes before final welding.",
        "Confirm tracking dimensions and coat steel."
      ]
    },
    {
      match: ["gate", "panel", "screen", "sign", "wall"],
      material: "flat bar, light tube, and sheet plate",
      partName: ["Outer rail", "Cross rail", "Upright", "Detail member", "Mount tab", "Trim cap"],
      steps: [
        "Cut and square all perimeter members.",
        "Tack outer frame on a flat table.",
        "Install interior members with equal spacing.",
        "Add decorative or mounting features.",
        "Verify flatness and final dimensions.",
        "Finish grind and paint/patina."
      ]
    }
  ]

  const lowerName = String(project || "").toLowerCase()
  const profile = keywordProfiles.find(entry => entry.match.some(word => lowerName.includes(word)))
  if (profile) {
    return applyProjectDetailProfile(project, style, L, W, H, {
      material: profile.material,
      parts: [
        ["A", profile.partName[0], 2, `${L}in`, "2x2 sq tube"],
        ["B", profile.partName[1], 2, `${W}in`, "2x2 sq tube"],
        ["C", profile.partName[2], 4, `${H}in`, "2x2 sq tube"],
        ["D", profile.partName[3], 2, `${Math.max(12, Math.round(L * 0.35))}in`, "1x1 sq tube"],
        ["E", profile.partName[4], 4, "4x3in", "3/16 plate"],
        ["F", profile.partName[5], 4, "4in", "3/16 plate"]
      ],
      steps: profile.steps
    })
  }

  return applyProjectDetailProfile(project, style, L, W, H, templates[category] || {
    material: "2x2 sq tube and 3/16 plate",
    parts: [
      ["A", "Main rail", 2, `${L}in`, "2x2 sq tube"],
      ["B", "Cross member", 3, `${W}in`, "2x2 sq tube"],
      ["C", "Upright", 4, `${H}in`, "2x2 sq tube"],
      ["D", "Brace", 2, `${W}in`, "1x1 sq tube"],
      ["E", "Top plate", 1, `${L}x${W}in`, "3/16 plate"],
      ["F", "Base foot", 4, "4in", "3/16 plate"]
    ],
    steps: [
      "Cut all stock to length.",
      "Tack the frame together on a flat table.",
      "Check all corners and diagonals.",
      "Complete welds and add braces.",
      "Grind or dress the necessary joints.",
      "Prime, paint, or seal the finished project."
    ]
  })
}

function buildStyleTemplate(project, style, L, W, H) {
  const cleanName = sanitizeText(project, 120)
  const shortName = cleanName.replace(/\b(frame|stand|rack|base|panel|piece|attachment)\b/gi, "").replace(/\s+/g, " ").trim() || cleanName

  const byStyle = {
    cart: {
      material: "1x1 to 2x2 tube, plate tabs, and caster mounts",
      parts: [
        ["A", `${shortName} top rail`, 2, `${L}in`, "1x1 or 2x2 tube"],
        ["B", `${shortName} lower rail`, 2, `${L}in`, "1x1 or 2x2 tube"],
        ["C", `${shortName} side rail`, 4, `${W}in`, "1x1 or 2x2 tube"],
        ["D", "Leg/upright", 4, `${H}in`, "1x1 or 2x2 tube"],
        ["E", "Accessory mount", 2, `${Math.max(10, Math.round(H * 0.4))}in`, "flat/tube"],
        ["F", "Caster plate", 4, "4x4in", "3/16 plate"]
      ],
      steps: [
        "Cut top, lower, and side rails.",
        "Build top frame and verify square.",
        "Install legs and lower frame.",
        "Add accessory mounts and gussets.",
        "Weld caster plates and check level.",
        "Final weld cleanup and finish."
      ]
    },
    pit: {
      material: "3/16 plate body with angle/flat reinforcement",
      parts: [
        ["A", `${shortName} long panel`, 2, `${L}x${H}in`, "3/16 plate"],
        ["B", `${shortName} short panel`, 2, `${W}x${H}in`, "3/16 plate"],
        ["C", "Bottom plate", 1, `${L}x${W}in`, "3/16 plate"],
        ["D", "Rim/trim", 4, `${Math.max(W, Math.round(L * 0.5))}in`, "1x1 angle/flat"],
        ["E", "Grate/support", 4, `${Math.max(10, Math.round(W * 0.6))}in`, "round rod/flat"],
        ["F", "Leg/mount tab", 4, "6in", "2x2 tube or plate"]
      ],
      steps: [
        "Cut all plate panels and bottom.",
        "Tack shell and verify square.",
        "Weld seams in staggered sequence.",
        "Install rim and grate supports.",
        "Add legs/tabs and clean edges.",
        "Apply high-temp or outdoor finish."
      ]
    },
    frame: {
      material: "2x2 tube with braces and plate mounts",
      parts: [
        ["A", `${shortName} main rail`, 2, `${L}in`, "2x2 sq tube"],
        ["B", `${shortName} cross rail`, 2, `${W}in`, "2x2 sq tube"],
        ["C", `${shortName} upright`, 4, `${H}in`, "2x2 sq tube"],
        ["D", "Brace", 2, `${Math.max(12, Math.round(L * 0.35))}in`, "1x1 sq tube"],
        ["E", "Mount plate", 4, "4x4in", "3/16 plate"],
        ["F", "Gusset", 4, "6in", "3/16 plate"]
      ],
      steps: [
        "Cut and prep all frame members.",
        "Tack frame and verify diagonals.",
        "Install uprights and braces.",
        "Fit mount plates and gussets.",
        "Complete welds with distortion control.",
        "Clean, inspect, and finish."
      ]
    },
    skid: {
      material: "5/16 quick-attach plate, 3x3 tube, 3/8 plate ears",
      parts: [
        ["A", `${shortName} top coupler rail`, 1, `${L}in`, "5/16 plate"],
        ["B", `${shortName} bottom coupler rail`, 1, `${L}in`, "5/16 plate"],
        ["C", `${shortName} center support`, 1, `${Math.max(12, Math.round(H * 0.8))}in`, "5/16 plate"],
        ["D", `${shortName} rear cross tube`, 2, `${Math.max(18, Math.round(L * 0.55))}in`, "3x3 sq tube"],
        ["E", "Pin ear pair", 2, "8x4in", "3/8 plate"],
        ["F", "Latch tab pair", 2, "6x3in", "3/8 plate"]
      ],
      steps: [
        "Cut quick-attach profile to coupler spec.",
        "Fit top and bottom rails to OEM centerlines.",
        "Install center support and rear cross tubes.",
        "Weld pin ears and latch tabs to final spacing.",
        "Test fit on machine before finish welding.",
        "Final weld and anti-corrosion finish."
      ]
    },
    hoist: {
      material: "3x3 to 4x4 structural tube and 3/8 gusset plate",
      parts: [
        ["A", `${shortName} base beam`, 2, `${L}in`, "3x3 sq tube"],
        ["B", `${shortName} base cross`, 1, `${W}in`, "3x3 sq tube"],
        ["C", `${shortName} mast`, 1, `${H}in`, "4x4 sq tube"],
        ["D", `${shortName} boom arm`, 1, `${Math.max(20, Math.round(L * 0.6))}in`, "3x3 sq tube"],
        ["E", "Gusset plate", 4, "8x8in", "3/8 plate"],
        ["F", "Caster/foot mount", 4, "6in", "3x3 sq tube"]
      ],
      steps: [
        "Build base and verify symmetry.",
        "Install mast plumb with gussets.",
        "Fabricate and fit boom arm.",
        "Install pivot and hook points.",
        "Fit feet/casters and check stability.",
        "Load test and finalize finish."
      ]
    },
    cage: {
      material: "1.75 DOM tube and 3/16 gusset plate",
      parts: [
        ["A", `${shortName} main hoop`, 1, `${H}x${W}in`, "1.75 DOM"],
        ["B", `${shortName} front hoop`, 1, `${Math.round(H * 0.9)}x${Math.round(W * 0.75)}in`, "1.75 DOM"],
        ["C", "Roof tube", 2, `${Math.max(20, Math.round(L * 0.5))}in`, "1.75 DOM"],
        ["D", "Side tube", 2, `${Math.max(20, Math.round(L * 0.5))}in`, "1.75 DOM"],
        ["E", "Node gusset", 8, "4in", "3/16 plate"],
        ["F", "Mount plate", 4, "6x4in", "3/16 plate"]
      ],
      steps: [
        "Bend and notch hoops and tubes.",
        "Tack on fixture/vehicle and verify clearances.",
        "Install roof and side tubes.",
        "Add gussets at high-load nodes.",
        "Weld mount plates to frame hard points.",
        "Final weld pass and protective coating."
      ]
    },
    murphy: {
      material: "2x3 and 2x2 tube with 3/8 pivot plates",
      parts: [
        ["A", "Wall frame upright", 4, `${H}in`, "2x3 rect tube"],
        ["B", "Wall frame rail", 4, `${W}in`, "2x3 rect tube"],
        ["C", "Bed side rail", 2, `${L}in`, "2x2 sq tube"],
        ["D", "Bed cross rail", 3, `${W}in`, "2x2 sq tube"],
        ["E", "Pivot arm", 2, "24in", "2x2 sq tube"],
        ["F", "Pivot plate", 4, "6x4in", "3/8 plate"]
      ],
      steps: [
        "Build wall anchor frame square.",
        "Build bed platform frame.",
        "Install pivot arms and plates.",
        "Anchor wall frame to structural studs.",
        "Test fold action and clearances.",
        "Install final hardware and finish."
      ]
    },
    lift: {
      material: "2x3 and 2x2 tube with 1in pivot pins",
      parts: [
        ["A", `${shortName} top frame`, 1, `${L}x${W}in`, "2x3/2x2 tube"],
        ["B", `${shortName} lower frame`, 1, `${L}x${W}in`, "2x3/2x2 tube"],
        ["C", "Scissor arm", 4, `${Math.max(18, Math.round(L * 0.6))}in`, "2x2 sq tube"],
        ["D", "Pivot pin", 4, `${Math.max(8, Math.round(W * 0.3))}in`, "1in round bar"],
        ["E", "Deck plate", 1, `${L}x${W}in`, "3/16 plate"],
        ["F", "Cylinder mount", 2, "6x4in", "3/8 plate"]
      ],
      steps: [
        "Build top and lower frames.",
        "Drill scissor arms and fit pins.",
        "Install center and end pivots.",
        "Fit actuator/cylinder mounts.",
        "Install deck and wheel/chock features.",
        "Cycle test before service use."
      ]
    },
    flatbed: {
      material: "3x2 main rails, 2x2 crossmembers, and 3/16 plate",
      parts: [
        ["A", `${shortName} main rail`, 2, `${L}in`, "3x2 rect tube"],
        ["B", `${shortName} crossmember`, 6, `${W}in`, "2x2 sq tube"],
        ["C", "Perimeter rail", 2, `${L}in`, "2x2 sq tube"],
        ["D", "Rack upright", 2, `${Math.max(20, Math.round(H * 0.8))}in`, "2x2 sq tube"],
        ["E", "Mount plate", 6, "6x4in", "3/16 plate"],
        ["F", "Deck plate", 1, `${L}x${W}in`, "3/16 plate"]
      ],
      steps: [
        "Layout main rails and crossmembers.",
        "Square and tack frame.",
        "Install perimeter/rack members.",
        "Fit mount plates and stake features.",
        "Install deck and finish welds.",
        "Check twist and coat steel."
      ]
    },
    trailer: {
      material: "3x2 and 2x2 structural tube with plate mounts",
      parts: [
        ["A", `${shortName} main rail`, 2, `${L}in`, "3x2 rect tube"],
        ["B", `${shortName} crossmember`, 4, `${W}in`, "2x2 sq tube"],
        ["C", "Support upright", 2, `${Math.max(18, Math.round(H * 0.5))}in`, "2x2 sq tube"],
        ["D", "Tongue/side member", 2, `${Math.max(36, Math.round(L * 0.5))}in`, "3x2 rect tube"],
        ["E", "Mount plate", 4, "6x4in", "3/16 plate"],
        ["F", "Gusset", 6, "6in", "3/16 plate"]
      ],
      steps: [
        "Build and square base frame.",
        "Install crossmembers and side/tongue members.",
        "Fit uprights and load supports.",
        "Install all mount and gusset plates.",
        "Check coupler/axle interface dimensions.",
        "Final weld and protective finish."
      ]
    },
    rack: {
      material: "2x2 sq tube, round stanchions, and mount inserts",
      parts: [
        ["A", `${shortName} side rail`, 2, `${L}in`, "2x2 sq tube"],
        ["B", `${shortName} cross rail`, 3, `${W}in`, "2x2 sq tube"],
        ["C", "Upright", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Stanchion", 4, "36in", "1.5 round tube"],
        ["E", "Mount insert", 4, "6in", "1.5 sq tube"],
        ["F", "Stop tab", 8, "3in", "3/16 plate"]
      ],
      steps: [
        "Build side assemblies and keep parallel.",
        "Install cross rails and uprights.",
        "Fit stanchions and stop tabs.",
        "Install inserts or mount feet.",
        "Test fit to host platform.",
        "Finish weld and coat."
      ]
    },
    railing: {
      material: "1.5 sq tube rails, 2x2 posts, and baluster bar",
      parts: [
        ["A", "Top rail", 1, `${L}in`, "1.5x1.5 sq tube"],
        ["B", "Bottom rail", 1, `${L}in`, "1.5x1.5 sq tube"],
        ["C", "Post", 3, `${H}in`, "2x2 sq tube"],
        ["D", "Baluster", 8, `${Math.max(18, H - 6)}in`, "1/2 sq bar"],
        ["E", "Base plate", 3, "4x4in", "3/16 plate"],
        ["F", "Post cap", 3, "2x2in", "3/16 plate"]
      ],
      steps: [
        "Cut rails, posts, and balusters.",
        "Weld base plates to posts.",
        "Set post spacing and tack rails.",
        "Install balusters to code spacing.",
        "Check level and plumb.",
        "Final weld and finish."
      ]
    },
    greenhouse: {
      material: "2x2 base tube, 1x1 uprights, and bent arches",
      parts: [
        ["A", "Base rail", 4, `${L}in`, "2x2 sq tube"],
        ["B", "Wall upright", 8, `${Math.round(H * 0.6)}in`, "1x1 sq tube"],
        ["C", "Roof arch", 6, `${W}in`, "1in round tube"],
        ["D", "Hip rafter", 2, `${L}in`, "1x1 sq tube"],
        ["E", "Glazing bar", 12, `${Math.max(10, Math.round(L / 6))}in`, "1in flat bar"],
        ["F", "Door frame", 1, `${Math.round(W / 3)}x${Math.round(H * 0.6)}in`, "1x1 sq tube"]
      ],
      steps: [
        "Assemble base frame and anchor points.",
        "Install uprights and check plumb.",
        "Fit arches and ridge members.",
        "Install glazing bars and door frame.",
        "Check alignment and rack.",
        "Finish prep for panel install."
      ]
    },
    mezzanine: {
      material: "6x4 beams, 4x2 joists, 4x4 columns, and plate brackets",
      parts: [
        ["A", "Main beam", 3, `${L}in`, "6x4 rect tube"],
        ["B", "Floor joist", 6, `${W}in`, "4x2 rect tube"],
        ["C", "Column", 4, `${H}in`, "4x4 sq tube"],
        ["D", "Beam bracket", 6, "8x6in", "3/8 plate"],
        ["E", "Base plate", 4, "12x12in", "1/2 plate"],
        ["F", "Safety post", 8, "42in", "2x2 sq tube"]
      ],
      steps: [
        "Build column/base assemblies.",
        "Stand and anchor columns.",
        "Install main beams and brackets.",
        "Install joists and verify level.",
        "Install safety posts/rails.",
        "Final weld and finish."
      ]
    },
    carport: {
      material: "4x4 posts, 4x2 beams, 2x2 purlins, and base plates",
      parts: [
        ["A", "Post", 4, `${H}in`, "4x4 sq tube"],
        ["B", "Beam", 2, `${L}in`, "4x2 rect tube"],
        ["C", "Purlin", 6, `${W}in`, "2x2 sq tube"],
        ["D", "Knee brace", 4, "24in", "2x2 sq tube"],
        ["E", "Base plate", 4, "10x10in", "3/8 plate"],
        ["F", "Ridge member", 1, `${L}in`, "2x2 sq tube"]
      ],
      steps: [
        "Prep posts and base plates.",
        "Set posts plumb and brace.",
        "Install beams and purlins.",
        "Add knee braces and ridge member.",
        "Verify bay dimensions and square.",
        "Final weld and protective coating."
      ]
    },
    pergola: {
      material: "4x4 posts, 4x2 beams, and 2x2 rafters",
      parts: [
        ["A", "Post", 4, `${H}in`, "4x4 sq tube"],
        ["B", "Beam", 2, `${L}in`, "4x2 rect tube"],
        ["C", "Rafter", 6, `${W}in`, "2x2 sq tube"],
        ["D", "Base plate", 4, "8x8in", "3/8 plate"],
        ["E", "Knee brace", 4, "24in", "2x2 sq tube"],
        ["F", "Tie plate", 12, "3in", "3/16 plate"]
      ],
      steps: [
        "Prep posts and base anchors.",
        "Set post layout and plumb.",
        "Install beams and rafters.",
        "Add braces and tie plates.",
        "Check spacing and level.",
        "Finish and weatherproof."
      ]
    },
    planter: {
      material: "plate body with cap rails and drain features",
      parts: [
        ["A", "Long wall", 2, `${L}x${H}in`, "3/16 plate"],
        ["B", "Short wall", 2, `${W}x${H}in`, "3/16 plate"],
        ["C", "Corner post", 4, `${H + 2}in`, "1.5x1.5 sq tube"],
        ["D", "Cap rail long", 2, `${L}in`, "1x2 flat bar"],
        ["E", "Cap rail short", 2, `${W}in`, "1x2 flat bar"],
        ["F", "Drain strip", 2, `${L}in`, "1x1 angle"]
      ],
      steps: [
        "Cut and prep all wall panels.",
        "Tack panels to corner posts.",
        "Weld seams and add cap rails.",
        "Install drain strips/holes.",
        "Deburr all exposed edges.",
        "Apply desired finish."
      ]
    },
    table: {
      material: "2x2 and 1x1 tube with plate or tab top support",
      parts: [
        ["A", `${shortName} long rail`, 2, `${L}in`, "2x2 sq tube"],
        ["B", `${shortName} short rail`, 2, `${W}in`, "2x2 sq tube"],
        ["C", `${shortName} leg`, 4, `${H}in`, "2x2 sq tube"],
        ["D", "Cross brace", 2, `${Math.max(12, Math.round(L * 0.35))}in`, "1x1 sq tube"],
        ["E", "Top support tab", 4, "3in", "3/16 plate"],
        ["F", "Foot/leveler", 4, "1in", "threaded/rubber"]
      ],
      steps: [
        "Build top frame square.",
        "Install legs and lower braces.",
        "Add cross bracing and tabs.",
        "Verify level and diagonal.",
        "Dress welds as required.",
        "Finish coat and assemble top."
      ]
    },
    bookshelf: {
      material: "pipe/tube uprights with shelf supports",
      parts: [
        ["A", "Upright", 4, `${H}in`, "1in pipe or 1x1 tube"],
        ["B", "Shelf support long", 5, `${L}in`, "1x1 tube"],
        ["C", "Shelf support short", 10, `${W}in`, "1x1 tube"],
        ["D", "Mount bracket", 4, "6in", "3/16 plate"],
        ["E", "Shelf tab", 10, "3in", "3/16 plate"],
        ["F", "Stiffener", 4, `${Math.max(8, Math.round(W * 0.5))}in`, "1x1 tube"]
      ],
      steps: [
        "Build side upright assemblies.",
        "Install shelf supports at layout heights.",
        "Add wall/floor mount brackets.",
        "Install shelf tabs/stiffeners.",
        "Check plumb and level.",
        "Finish and install shelf boards."
      ]
    },
    winerack: {
      material: "1x1 tube frame with 1/2 rod cradles",
      parts: [
        ["A", "Upright", 2, `${H}in`, "1x1 sq tube"],
        ["B", "Horizontal rail", 6, `${L}in`, "1x1 sq tube"],
        ["C", "Bottle cradle rod", 12, `${W}in`, "1/2 round rod"],
        ["D", "Wall tab", 4, "4in", "3/16 plate"],
        ["E", "Top shelf", 1, `${L}x6in`, "3/16 plate"],
        ["F", "Label rail", 6, `${Math.max(4, Math.round(L / 6))}in`, "1x1/8 flat bar"]
      ],
      steps: [
        "Build perimeter frame.",
        "Install horizontal rails.",
        "Fit bottle cradle rods in pairs.",
        "Install wall tabs and top shelf.",
        "Check spacing for bottle clearance.",
        "Finish and mount."
      ]
    },
    wallshelf: {
      material: "plate brackets and hidden support rods",
      parts: [
        ["A", "Bracket arm", 3, "12in", "3/8 plate"],
        ["B", "Wall plate", 3, "6x4in", "3/16 plate"],
        ["C", "Stiffener", 3, "8in", "3/16 plate"],
        ["D", "Shelf rod", 6, `${Math.max(8, Math.round(L / 3))}in`, "round bar"],
        ["E", "End cap", 6, "2in", "3/16 plate"],
        ["F", "Set screw tab", 3, "1in", "1/8 flat bar"]
      ],
      steps: [
        "Fabricate bracket arms and wall plates.",
        "Install stiffeners and support rods.",
        "Mount wall plates to studs.",
        "Fit shelf body over rods.",
        "Set and lock with screws.",
        "Touch up finish."
      ]
    },
    sculpture: {
      material: "base plate, rod armature, and formed sheet",
      parts: [
        ["A", "Base plate", 1, "12x12in", "1/2 plate"],
        ["B", "Armature rod", 4, `${H}in`, "1/2 round rod"],
        ["C", "Body form", 1, `${Math.max(10, Math.round(L * 0.3))}x${Math.max(10, Math.round(H * 0.3))}in`, "14ga sheet"],
        ["D", "Detail element", 6, "varies", "scrap steel"],
        ["E", "Texture piece", 8, "varies", "chain/bolt/nut"],
        ["F", "Mount stud", 4, "2in", "3/8 threaded rod"]
      ],
      steps: [
        "Build armature on base plate.",
        "Form and tack body shell.",
        "Install detail and texture components.",
        "Balance sculpture and check stance.",
        "Final weld and blend edges.",
        "Apply patina or clear coat."
      ]
    },
    gate: {
      material: "flat bar frame with pickets/panels and hardware",
      parts: [
        ["A", `${shortName} outer rail`, 2, `${L}in`, "1x2 flat bar or tube"],
        ["B", `${shortName} outer stile`, 2, `${H}in`, "1x2 flat bar or tube"],
        ["C", "Inner member", 6, `${Math.max(12, Math.round(H * 0.7))}in`, "1/2 sq bar"],
        ["D", "Diagonal/brace", 1, `${Math.max(L, H)}in`, "flat bar"],
        ["E", "Hinge tab", 2, "5in", "hinge/tab plate"],
        ["F", "Latch tab", 1, "std", "latch hardware"]
      ],
      steps: [
        "Build perimeter frame square.",
        "Install interior members and braces.",
        "Fit hinge and latch tabs.",
        "Check swing/fitment clearances.",
        "Complete welds and grind as needed.",
        "Apply finish coat."
      ]
    },
    furniture: {
      material: "1x1 to 2x2 tube with mount tabs and braces",
      parts: [
        ["A", `${shortName} long rail`, 2, `${L}in`, "1x1 or 2x2 tube"],
        ["B", `${shortName} short rail`, 2, `${W}in`, "1x1 or 2x2 tube"],
        ["C", "Leg/support", 4, `${H}in`, "1x1 or 2x2 tube"],
        ["D", "Cross brace", 2, `${Math.max(12, Math.round(L * 0.35))}in`, "1x1 tube"],
        ["E", "Mount tab", 4, "3in", "3/16 plate"],
        ["F", "Foot/leveler", 4, "1in", "rubber/threaded"]
      ],
      steps: [
        "Cut rails and supports.",
        "Build frame square and level.",
        "Install legs and braces.",
        "Add tabs and mount points.",
        "Dress visible welds.",
        "Finish and final assembly."
      ]
    },
    struct: {
      material: "structural tube and plate gusset/brackets",
      parts: [
        ["A", `${shortName} main member`, 2, `${L}in`, "4x2 or 6x4 tube"],
        ["B", `${shortName} cross member`, 4, `${W}in`, "2x2 or 4x2 tube"],
        ["C", "Column/upright", 4, `${H}in`, "2x2 to 4x4 tube"],
        ["D", "Brace", 4, `${Math.max(16, Math.round(H * 0.35))}in`, "2x2 tube"],
        ["E", "Base/mount plate", 4, "8x8in", "3/8 plate"],
        ["F", "Gusset", 8, "6in", "3/16 plate"]
      ],
      steps: [
        "Lay out primary members.",
        "Tack and verify structural square.",
        "Install uprights and braces.",
        "Fit plates and gussets.",
        "Check plumb/level and diagonals.",
        "Complete weld schedule and coat."
      ]
    },
    outdoor: {
      material: "plate and tube sections for exterior use",
      parts: [
        ["A", `${shortName} side member`, 2, `${L}in`, "tube/plate"],
        ["B", `${shortName} end member`, 2, `${W}in`, "tube/plate"],
        ["C", "Support/upright", 4, `${H}in`, "tube"],
        ["D", "Panel/insert", 2, `${Math.max(12, Math.round(L * 0.6))}in`, "plate/sheet"],
        ["E", "Bracket/tab", 4, "4in", "3/16 plate"],
        ["F", "Trim/rim", 4, `${Math.max(8, Math.round(W * 0.5))}in`, "flat/angle"]
      ],
      steps: [
        "Cut members and set layout.",
        "Build and square frame.",
        "Install supports and inserts.",
        "Add tabs/trim features.",
        "Deburr and clean welds.",
        "Apply outdoor-rated finish."
      ]
    },
    shelf: {
      material: "1x1 to 2x2 tube with shelf supports",
      parts: [
        ["A", `${shortName} long rail`, 2, `${L}in`, "2x2 sq tube"],
        ["B", `${shortName} short rail`, 3, `${W}in`, "2x2 sq tube"],
        ["C", "Leg/upright", 4, `${H}in`, "2x2 sq tube"],
        ["D", "Shelf rail", 2, `${L}in`, "1x1 sq tube"],
        ["E", "Mount/top plate", 1, `${L}x${W}in`, "3/16 plate"],
        ["F", "Foot/caster plate", 4, "4x4in", "3/16 plate"]
      ],
      steps: [
        "Cut and prep all members.",
        "Tack top frame square.",
        "Install legs/uprights.",
        "Add shelf rails and supports.",
        "Fit top plate or mounting tabs.",
        "Final weld and finish."
      ]
    },
    decor: {
      material: "14ga to 3/16 plate and light support members",
      parts: [
        ["A", `${shortName} base/backer`, 1, `${Math.max(12, Math.round(W * 0.8))}x${Math.max(12, Math.round(H * 0.8))}in`, "14ga/3/16 plate"],
        ["B", "Primary form", 1, `${Math.max(12, Math.round(L * 0.8))}in`, "14ga/3/16 plate"],
        ["C", "Support element", 2, `${Math.max(8, Math.round(H * 0.6))}in`, "rod/tube"],
        ["D", "Detail element", 4, "varies", "plate/scrap steel"],
        ["E", "Mount tab", 2, "3in", "3/16 plate"],
        ["F", "Trim/detail strip", 4, "varies", "flat bar"]
      ],
      steps: [
        "Cut primary decorative pieces.",
        "Tack to backer/support structure.",
        "Add details and layering.",
        "Check visual alignment.",
        "Final weld and edge cleanup.",
        "Apply patina/paint/clear."
      ]
    }
  }

  return byStyle[style] || null
}

function getWeldSettings(thickness, process) {
  const byThickness = {
    "1/8": { volts: "18.5", wfs: "300 ipm", amps: "~130A", preheat: "None" },
    "3/16": { volts: "19.5", wfs: "330 ipm", amps: "~160A", preheat: "None" },
    "1/4": { volts: "21.0", wfs: "360 ipm", amps: "~185A", preheat: "None" },
    "1/2": { volts: "23.0", wfs: "400 ipm", amps: "~220A", preheat: "150F min" }
  }
  const ws = byThickness[thickness] || byThickness["3/16"]
  const technique = process === "TIG" ? "Pull 10-15 deg" : process === "Flux Core" ? "Drag 5-10 deg" : "Push 10-15 deg"
  return { ...ws, technique }
}

function getProjectStyle(project) {
  const category = blueprintGallery[project] && blueprintGallery[project].category
  if (project === "Engine Hoist") return "hoist"
  if (project === "Engine Stand") return "hoist"
  if (project === "Gantry Crane") return "hoist"
  if (project === "ATV Roll Cage") return "cage"
  if (project === "Stair Railing") return "railing"
  if (project === "Pipe Handrail") return "railing"
  if (project === "Greenhouse Frame") return "greenhouse"
  if (project === "Mezzanine Frame") return "mezzanine"
  if (project === "Shelter Truss") return "struct"
  if (project === "Shop Door Frame") return "gate"
  if (project === "Carport Frame") return "carport"
  if (project === "Pergola Frame") return "pergola"
  if (project === "Raised Garden Bed") return "planter"
  if (project === "Planter Stand") return "planter"
  if (project === "Truck Flatbed") return "flatbed"
  if (project === "Skid Loader Attachment Frame") return "skid"
  if (project === "Dump Trailer") return "trailer"
  if (project === "Smoker Trailer") return "trailer"
  if (project === "Trailer Spare Tire Mount") return "trailer"
  if (project === "Receiver Hitch Carrier") return "trailer"
  if (project === "Headache Rack" || project === "Truck Toolbox Rack" || project === "Pipe Rack") return "rack"
  if (project === "Ladder Rack" || project === "Material Rack" || project === "Firewood Rack") return "rack"
  if (project === "Industrial Bookshelf") return "bookshelf"
  if (project === "Wine Rack") return "winerack"
  if (project === "Welded Sculpture") return "sculpture"
  if (project === "Murphy Bed Frame") return "murphy"
  if (project === "Floating Wall Shelves") return "wallshelf"
  if (project === "Motorcycle Lift") return "lift"
  if (project === "Welding Cart") return "cart"
  if (project === "Welding Table" || project === "Shop Workbench" || project === "Coffee Table" || project === "Dining Table Base" || project === "Patio Table Base" || project === "Console Desk Frame" || project === "Entry Console Table" || project === "TV Stand Frame" || project === "Kitchen Island Base") return "table"
  if (project === "Band Saw Stand" || project === "Angle Grinder Stand" || project === "Drill Press Stand" || project === "Tube Bender Stand" || project === "Chop Saw Stand") return "shelf"
  if (project === "Tool Cabinet") return "shelf"
  if (project === "Fence Panel" || project === "Trellis Panel" || project === "Decorative Screen Panel" || project === "Steel Sign" || project === "Custom Address Sign") return "gate"
  if (project === "Mailbox Post Frame" || project === "Arbor Arch") return "outdoor"
  if (project === "Monogram Wall Piece" || project === "Metal Clock Frame" || project === "Decorative Candle Sconce" || project === "Hanging Pot Rack" || project === "Candle Holder" || project === "Metal Wall Art" || project === "Geometric Planter" || project === "Steel Bookends") return "decor"
  if (project === "Bed Frame" || project === "Bar Stool" || project === "Entry Bench Frame") return "furniture"
  if (category === "Truck & Trailers") return "trailer"
  if (project === "Fire Pit" || project === "BBQ Grill") return "pit"
  if (project === "Garden Gate" || project === "Steel Sign") return "gate"
  if (project === "Outdoor Bench" || category === "Home & Furniture") return "furniture"
  if (category === "Structural & Frames") return "struct"
  if (category === "Outdoor & Garden") return "outdoor"
  if (category === "Shop Equipment") return "shelf"
  if (category === "Art & Decorative") return "decor"
  return "frame"
}

function drawBlueprintPageShell(doc, palette, title, subtitle, pageLabel) {
  const PW = 1190
  const PH = 842
  const margin = 24

  doc.addPage({
    size: [PW, PH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  })

  doc.rect(0, 0, PW, PH).fill(palette.paper)
  for (let x = 0; x <= PW; x += 40) doc.moveTo(x, 0).lineTo(x, PH).strokeColor(palette.grid).lineWidth(0.5).stroke()
  for (let y = 0; y <= PH; y += 40) doc.moveTo(0, y).lineTo(PW, y).strokeColor(palette.grid).lineWidth(0.5).stroke()

  doc.rect(margin, margin, PW - margin * 2, PH - margin * 2).strokeColor(palette.ink).lineWidth(1.2).stroke()
  doc.rect(margin + 10, margin + 10, PW - (margin + 10) * 2, PH - (margin + 10) * 2).strokeColor(palette.thin).lineWidth(0.8).stroke()

  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(22).text(title, margin + 18, margin + 16, { width: 760 })
  doc.fillColor(palette.thin).font("Helvetica").fontSize(10).text(subtitle, margin + 18, margin + 44, { width: 760 })
  if (pageLabel) {
    doc.fillColor(palette.thin).font("Helvetica-Bold").fontSize(10).text(pageLabel, PW - margin - 180, margin + 24, { width: 160, align: "right" })
  }

  return { PW, PH, margin }
}

function summarizeMaterialTakeoff(parts) {
  const totals = {
    tubeInches: 0,
    rodInches: 0,
    platePieces: 0,
    hardwarePieces: 0
  }

  parts.forEach(part => {
    const qty = Math.max(1, Number(part.qty || part[2]) || 1)
    const material = String(part.material || part[4] || "").toLowerCase()
    const lengthText = String(part.length || part[3] || "")
    const linearIn = parseLengthInches(lengthText)

    if (linearIn && /(tube|pipe)/.test(material)) totals.tubeInches += linearIn * qty
    if (linearIn && /(rod|bar)/.test(material)) totals.rodInches += linearIn * qty
    if (/(plate|sheet)/.test(material)) totals.platePieces += qty
    if (/hinge|latch|bolt|pin|caster|wheel/.test(material)) totals.hardwarePieces += qty
  })

  return {
    tubeFeet: (totals.tubeInches / 12).toFixed(1),
    rodFeet: (totals.rodInches / 12).toFixed(1),
    platePieces: totals.platePieces,
    hardwarePieces: totals.hardwarePieces
  }
}

function buildWeldScheduleRows(style, process, thickness) {
  const byStyle = {
    trailer: [
      "Main rail to crossmember",
      "Tongue to main rail node",
      "Axle mount reinforcement",
      "Perimeter rail corners",
      "Stake/tie-down tab attach",
      "Deck support seam"
    ],
    flatbed: [
      "Main rail to crossmember",
      "Headache rack uprights",
      "Perimeter rail corners",
      "Mount plate to frame",
      "Deck support seam",
      "Rear support node"
    ],
    cage: [
      "Main hoop base node",
      "Front hoop node",
      "Roof tube intersections",
      "Side intrusion bars",
      "Node gusset plates",
      "Mount plate nodes"
    ],
    hoist: [
      "Base beam corner joints",
      "Mast to base node",
      "Boom arm connection",
      "Gusset to mast seams",
      "Caster/foot mounts",
      "Load hook plate"
    ],
    rack: [
      "Upright to base rail",
      "Cross rail joints",
      "Stanchion mounts",
      "Tie-down tab joints",
      "Stop tab details",
      "Mount insert seams"
    ],
    shelf: [
      "Leg to frame corner",
      "Shelf rail to uprights",
      "Brace intersections",
      "Top plate or tab seams",
      "Foot plate joints",
      "Accessory mount tabs"
    ]
  }

  const locations = byStyle[style] || [
    "Primary frame corners",
    "Crossmember intersections",
    "Upright support joints",
    "Diagonal brace nodes",
    "Mount tab details",
    "Final assembly seams"
  ]

  const typeCycle = ["Fillet", "Fillet", "Fillet", "Groove", "Plug", "Stitch"]
  const symbolCycle = ["FIL", "FIL", "FIL", "GRV", "PLG", "STC"]
  const sizeByThickness = {
    "1/8": "3/16 in",
    "3/16": "1/4 in",
    "1/4": "1/4 in",
    "1/2": "5/16 in"
  }
  const defaultSize = sizeByThickness[thickness] || "1/4 in"

  return locations.map((location, index) => ({
    id: `J${index + 1}`,
    location,
    type: typeCycle[index % typeCycle.length],
    symbol: symbolCycle[index % symbolCycle.length],
    size: defaultSize,
    process: process
  }))
}

function buildToleranceRows(L, W, H) {
  const largest = Math.max(L, W, H)
  const linearTol = largest > 120 ? "+/- 1/8 in" : "+/- 1/16 in"
  const mediumTol = largest > 120 ? "+/- 3/32 in" : "+/- 1/16 in"

  return [
    ["Overall length", `${L} in`, linearTol, "Tape from datum A"],
    ["Overall width", `${W} in`, linearTol, "Tape from datum B"],
    ["Overall height", `${H} in`, mediumTol, "Height gauge or square"],
    ["Diagonal difference", "Target 0 in", "<= 1/8 in", "Cross-corner check"],
    ["Hole/tab position", "Per drawing", "+/- 1/32 in", "Rule and center punch"],
    ["Frame plumb", "Vertical", "<= 0.5 deg", "Digital angle finder"],
    ["Surface flatness", "Top plane", "<= 1/16 in over 24 in", "Straight edge"],
    ["Final fit-up gap", "Joint prep", "1/32 to 1/16 in", "Feelers before weld"]
  ]
}

function buildBlueprintQaScorecard(projectData, dimensions, process, thickness) {
  const partCount = Array.isArray(projectData.parts) ? projectData.parts.length : 0
  const stepCount = Array.isArray(projectData.steps) ? projectData.steps.length : 0
  const calloutCount = Array.isArray(projectData.callouts) ? projectData.callouts.length : 0
  const hasFeatureSummary = !!sanitizeText(projectData.featureSummary, 120)
  const largeBuild = dimensions.L >= 96 || dimensions.W >= 48 || dimensions.H >= 60

  const cutList = clampNumber(Math.round(9 + partCount * 1.2), 10, 25)
  const assembly = clampNumber(Math.round(8 + stepCount * 1.3), 8, 20)
  const projectSpecific = clampNumber(Math.round(6 + calloutCount * 3.5 + (hasFeatureSummary ? 2 : 0)), 6, 20)

  const processBase = process === "MIG" ? 16 : process === "TIG" ? 15 : 14
  const thicknessPenaltyMap = { "1/8": 0, "3/16": 1, "1/4": 2, "1/2": 3 }
  const thicknessPenalty = thicknessPenaltyMap[thickness] || 1
  const weldReadiness = clampNumber(processBase - thicknessPenalty + Math.min(3, calloutCount), 10, 20)

  const inspectionCoverage = clampNumber(
    Math.round(9 + Math.min(5, Math.ceil(partCount / 2)) + (largeBuild ? 1 : 0)),
    9,
    15
  )

  const rows = [
    { label: "Cut list completeness", score: cutList, max: 25 },
    { label: "Assembly sequencing", score: assembly, max: 20 },
    { label: "Project-specific detailing", score: projectSpecific, max: 20 },
    { label: "Weld readiness package", score: weldReadiness, max: 20 },
    { label: "Inspection coverage", score: inspectionCoverage, max: 15 }
  ]

  const total = rows.reduce((sum, row) => sum + row.score, 0)
  const grade = total >= 92 ? "A" : total >= 85 ? "B" : total >= 75 ? "C" : "D"
  const releaseTarget = 85
  const releaseStatus = total >= releaseTarget
    ? "Release-ready after in-shop verification."
    : "Add detail depth before customer release."

  return {
    rows,
    total,
    grade,
    releaseTarget,
    releaseStatus
  }
}

function buildBlueprintDocumentMeta(payload) {
  const canonical = [
    sanitizeText(payload.project, 120).toLowerCase(),
    `${payload.dimensions.L}x${payload.dimensions.W}x${payload.dimensions.H}`,
    sanitizeText(payload.process, 40).toLowerCase(),
    sanitizeText(payload.wire, 40).toLowerCase(),
    sanitizeText(payload.wiresize, 20).toLowerCase(),
    sanitizeText(payload.gas, 40).toLowerCase(),
    sanitizeText(payload.thickness, 20).toLowerCase()
  ].join("|")
  const hash = crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 10).toUpperCase()
  const issuedAt = new Date()

  return {
    revision: "A",
    version: "1.0",
    docId: `WB-${hash}`,
    issuedDate: issuedAt.toISOString().slice(0, 10),
    issuedTime: `${issuedAt.toISOString().slice(11, 16)} UTC`,
    releaseType: "Customer Release"
  }
}

function drawFabricationPackagePage(doc, context) {
  const { project, projectMeta, projectData, dimensions, style, process, thickness, palette, documentMeta } = context
  const shell = drawBlueprintPageShell(
    doc,
    palette,
    `${project.toUpperCase()} - FABRICATION PACKAGE`,
    "Detailed cut list, operation sequence, and setup controls",
    "PAGE 2 OF 3"
  )

  const left = { x: 56, y: 118, w: 760, h: 680 }
  const right = { x: 836, y: 118, w: 300, h: 680 }
  doc.rect(left.x, left.y, left.w, left.h).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.rect(right.x, right.y, right.w, right.h).strokeColor(palette.thin).lineWidth(0.8).stroke()

  const normalizedParts = (projectData.parts || []).map((part, index) => ({
    item: String(part[0] || itemCodeFromIndex(index)),
    name: sanitizeText(part[1], 70) || "Part",
    qty: Math.max(1, Number(part[2]) || 1),
    length: sanitizeText(part[3], 32) || "varies",
    material: sanitizeText(part[4], 40) || "steel"
  }))

  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("FULL CUT LIST", left.x + 8, left.y + 8)
  const cols = [left.x + 8, left.x + 56, left.x + 384, left.x + 430, left.x + 512, left.x + 612]
  doc.font("Helvetica-Bold").fontSize(9)
  doc.text("ITEM", cols[0], left.y + 30)
  doc.text("DESCRIPTION", cols[1], left.y + 30)
  doc.text("QTY", cols[2], left.y + 30)
  doc.text("LENGTH", cols[3], left.y + 30)
  doc.text("MATERIAL", cols[4], left.y + 30)
  doc.text("CUT NOTE", cols[5], left.y + 30)
  doc.moveTo(left.x + 6, left.y + 44).lineTo(left.x + left.w - 6, left.y + 44).strokeColor(palette.thin).lineWidth(0.8).stroke()

  const rowHeight = 22
  const maxRows = 22
  normalizedParts.slice(0, maxRows).forEach((part, rowIndex) => {
    const y = left.y + 50 + rowIndex * rowHeight
    const linearLength = parseLengthInches(part.length)
    const cutNote = linearLength ? `${Math.round(linearLength / 2)}in ref stop` : "Template fit"
    doc.font("Helvetica").fontSize(8.3).fillColor(palette.ink)
    doc.text(part.item, cols[0], y)
    doc.text(part.name, cols[1], y, { width: 320 })
    doc.text(String(part.qty), cols[2], y)
    doc.text(part.length, cols[3], y)
    doc.text(part.material, cols[4], y, { width: 94 })
    doc.text(cutNote, cols[5], y, { width: 130 })
    doc.moveTo(left.x + 6, y + 16).lineTo(left.x + left.w - 6, y + 16).strokeColor(palette.grid).lineWidth(0.6).stroke()
  })

  const takeoff = summarizeMaterialTakeoff(normalizedParts)
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("MATERIAL TAKEOFF", right.x + 8, right.y + 8)
  const takeoffRows = [
    `Tube/Pipe: ${takeoff.tubeFeet} ft`,
    `Rod/Bar: ${takeoff.rodFeet} ft`,
    `Plate/Sheet pieces: ${takeoff.platePieces}`,
    `Hardware/fit items: ${takeoff.hardwarePieces}`,
    `Style profile: ${style}`,
    `Weld process: ${process} @ ${thickness}`
  ]
  takeoffRows.forEach((row, i) => {
    doc.font("Helvetica").fontSize(8.7).fillColor(palette.ink).text(row, right.x + 8, right.y + 30 + i * 14, { width: right.w - 16 })
  })

  doc.moveTo(right.x + 6, right.y + 126).lineTo(right.x + right.w - 6, right.y + 126).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("OPERATIONS", right.x + 8, right.y + 134)
  const operations = uniqueStrings([
    ...(projectData.steps || []),
    "Deburr and stamp each part with item code.",
    "Fixture frame on flat table and re-check diagonals.",
    "Tack sequence complete before full weld-out.",
    "Final verification against tolerance table."
  ], 11)
  operations.forEach((step, i) => {
    doc.font("Helvetica").fontSize(8.5).fillColor(palette.ink)
      .text(`${i + 1}. ${step}`, right.x + 8, right.y + 154 + i * 14, { width: right.w - 16 })
  })

  doc.moveTo(right.x + 6, right.y + 528).lineTo(right.x + right.w - 6, right.y + 528).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(10).text("SETUP CHECKLIST", right.x + 8, right.y + 536)
  const checklist = [
    "Fixture table level and clean",
    "Datum line marked on all major parts",
    "Cut labels match parts list item codes",
    "Weld coupons verified for process settings",
    "Final dry-fit completed before full weld"
  ]
  checklist.forEach((item, i) => {
    const y = right.y + 556 + i * 18
    doc.rect(right.x + 8, y + 1, 9, 9).strokeColor(palette.thin).lineWidth(0.8).stroke()
    doc.font("Helvetica").fontSize(8.3).fillColor(palette.ink).text(item, right.x + 22, y, { width: right.w - 30 })
  })

  const sizeLine = `${dimensions.L} x ${dimensions.W} x ${dimensions.H} in`
  const profile = `${projectMeta.category || "General"} / ${projectMeta.difficulty || "General"} / ${projectMeta.time || "Varies"}`
  const docTag = documentMeta && documentMeta.docId
    ? `   DOC: ${documentMeta.docId} REV ${documentMeta.revision}`
    : ""
  doc.fillColor(palette.thin).font("Helvetica").fontSize(9).text(
    `SIZE: ${sizeLine}   PROFILE: ${profile}${docTag}`,
    shell.margin + 12,
    shell.PH - 24,
    { width: shell.PW - 120 }
  )
}

function drawWeldAndQaPage(doc, context) {
  const { project, process, thickness, dimensions, style, projectData, ws, palette, documentMeta } = context
  const shell = drawBlueprintPageShell(
    doc,
    palette,
    `${project.toUpperCase()} - WELD MAP & QA`,
    "Weld symbol legend, tolerance matrix, and inspection checks",
    "PAGE 3 OF 3"
  )

  const leftTop = { x: 56, y: 118, w: 520, h: 220 }
  const leftMid = { x: 56, y: 350, w: 520, h: 272 }
  const leftBottom = { x: 56, y: 632, w: 520, h: 166 }
  const right = { x: 590, y: 118, w: 546, h: 680 }
  ;[leftTop, leftMid, leftBottom, right].forEach(box => {
    doc.rect(box.x, box.y, box.w, box.h).strokeColor(palette.thin).lineWidth(0.8).stroke()
  })

  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("WELD SYMBOL LEGEND", leftTop.x + 8, leftTop.y + 8)
  const legendRows = [
    ["FIL", "Fillet weld", "Frame corners, braces, tabs"],
    ["GRV", "Groove/Butt weld", "Primary full-penetration seams"],
    ["PLG", "Plug/Rosette weld", "Plate attachment points"],
    ["STC", "Stitch weld", "Intermittent seam sections"],
    ["BCK", "Back-step sequence", "Distortion control on long seams"]
  ]
  legendRows.forEach((row, i) => {
    const y = leftTop.y + 34 + i * 32
    doc.rect(leftTop.x + 8, y - 2, 34, 16).strokeColor(palette.thin).lineWidth(0.8).stroke()
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(palette.ink).text(row[0], leftTop.x + 15, y + 2)
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(palette.ink).text(row[1], leftTop.x + 50, y)
    doc.font("Helvetica").fontSize(8.3).fillColor(palette.thin).text(row[2], leftTop.x + 50, y + 12, { width: leftTop.w - 58 })
  })

  const weldRows = buildWeldScheduleRows(style, process, thickness)
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("WELD SCHEDULE", leftMid.x + 8, leftMid.y + 8)
  const weldCols = [leftMid.x + 8, leftMid.x + 48, leftMid.x + 276, leftMid.x + 330, leftMid.x + 378, leftMid.x + 440]
  doc.font("Helvetica-Bold").fontSize(8.5)
  doc.text("ID", weldCols[0], leftMid.y + 30)
  doc.text("LOCATION", weldCols[1], leftMid.y + 30)
  doc.text("TYPE", weldCols[2], leftMid.y + 30)
  doc.text("SYM", weldCols[3], leftMid.y + 30)
  doc.text("SIZE", weldCols[4], leftMid.y + 30)
  doc.text("PROC", weldCols[5], leftMid.y + 30)
  doc.moveTo(leftMid.x + 6, leftMid.y + 44).lineTo(leftMid.x + leftMid.w - 6, leftMid.y + 44).strokeColor(palette.thin).lineWidth(0.8).stroke()
  weldRows.forEach((row, i) => {
    const y = leftMid.y + 50 + i * 30
    doc.font("Helvetica").fontSize(8.4).fillColor(palette.ink)
    doc.text(row.id, weldCols[0], y)
    doc.text(row.location, weldCols[1], y, { width: 220 })
    doc.text(row.type, weldCols[2], y)
    doc.text(row.symbol, weldCols[3], y)
    doc.text(row.size, weldCols[4], y)
    doc.text(row.process, weldCols[5], y)
    doc.moveTo(leftMid.x + 6, y + 20).lineTo(leftMid.x + leftMid.w - 6, y + 20).strokeColor(palette.grid).lineWidth(0.6).stroke()
  })

  const toleranceRows = buildToleranceRows(dimensions.L, dimensions.W, dimensions.H)
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("TOLERANCE MATRIX", leftBottom.x + 8, leftBottom.y + 8)
  const tolCols = [leftBottom.x + 8, leftBottom.x + 184, leftBottom.x + 272, leftBottom.x + 360]
  doc.font("Helvetica-Bold").fontSize(8.5)
  doc.text("FEATURE", tolCols[0], leftBottom.y + 30)
  doc.text("TARGET", tolCols[1], leftBottom.y + 30)
  doc.text("TOLERANCE", tolCols[2], leftBottom.y + 30)
  doc.text("METHOD", tolCols[3], leftBottom.y + 30)
  toleranceRows.slice(0, 6).forEach((row, i) => {
    const y = leftBottom.y + 46 + i * 18
    doc.font("Helvetica").fontSize(8.2).fillColor(palette.ink).text(row[0], tolCols[0], y, { width: 170 })
    doc.text(row[1], tolCols[1], y, { width: 82 })
    doc.text(row[2], tolCols[2], y, { width: 82 })
    doc.text(row[3], tolCols[3], y, { width: 150 })
  })

  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("INSPECTION & RELEASE", right.x + 8, right.y + 8)
  const qaChecks = uniqueStrings([
    "Material IDs verified against cut list",
    "All critical dims within tolerance table",
    "Weld visual quality passes (uniform bead, no undercut)",
    "No visible cracks/porosity at primary joints",
    "Frame remains square after full weld-out",
    "Flatness check passed on mating surfaces",
    "Threaded mounts/chasing completed",
    "Surface prep complete (spatter removed, edges deburred)",
    "Coating prep complete and documented",
    "Final fit-up test passed with mating hardware"
  ], 10)

  qaChecks.forEach((item, i) => {
    const y = right.y + 34 + i * 22
    doc.rect(right.x + 8, y + 1, 10, 10).strokeColor(palette.thin).lineWidth(0.8).stroke()
    doc.font("Helvetica").fontSize(8.6).fillColor(palette.ink).text(item, right.x + 24, y, { width: right.w - 32 })
  })

  doc.moveTo(right.x + 6, right.y + 278).lineTo(right.x + right.w - 6, right.y + 278).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("WELD SETTINGS", right.x + 8, right.y + 286)
  const weldSetup = [
    `Process: ${process}`,
    `Voltage/WFS: ${ws.volts} / ${ws.wfs}`,
    `Current: ${ws.amps}`,
    `Gas: ${payloadSafeGasLabel(process, context.gas)}`,
    `Technique: ${ws.technique}`,
    `Material thickness: ${thickness}`
  ]
  weldSetup.forEach((line, i) => {
    doc.font("Helvetica").fontSize(8.8).fillColor(palette.ink).text(line, right.x + 8, right.y + 306 + i * 14, { width: right.w - 16 })
  })

  const scorecard = buildBlueprintQaScorecard(projectData, dimensions, process, thickness)
  doc.moveTo(right.x + 6, right.y + 402).lineTo(right.x + right.w - 6, right.y + 402).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("BLUEPRINT QA SCORECARD", right.x + 8, right.y + 410)
  const scoreCols = [right.x + 8, right.x + 372, right.x + 432]
  doc.font("Helvetica-Bold").fontSize(8.3).fillColor(palette.thin)
  doc.text("CATEGORY", scoreCols[0], right.y + 426)
  doc.text("SCORE", scoreCols[1], right.y + 426)
  doc.text("MAX", scoreCols[2], right.y + 426)
  scorecard.rows.forEach((row, i) => {
    const y = right.y + 440 + i * 16
    doc.font("Helvetica").fontSize(8.3).fillColor(palette.ink).text(row.label, scoreCols[0], y, { width: 350 })
    doc.font("Helvetica-Bold").fontSize(8.3).fillColor(palette.ink).text(String(row.score), scoreCols[1], y, { width: 50, align: "right" })
    doc.font("Helvetica").fontSize(8.3).fillColor(palette.thin).text(String(row.max), scoreCols[2], y, { width: 40, align: "right" })
  })

  const totalY = right.y + 524
  doc.moveTo(right.x + 6, totalY).lineTo(right.x + right.w - 6, totalY).strokeColor(palette.grid).lineWidth(0.8).stroke()
  doc.font("Helvetica-Bold").fontSize(9).fillColor(palette.ink)
    .text(`TOTAL: ${scorecard.total}/100   GRADE: ${scorecard.grade}`, right.x + 8, totalY + 6, { width: right.w - 16 })
  doc.font("Helvetica").fontSize(8.2).fillColor(palette.thin)
    .text(`Release gate ${scorecard.releaseTarget}/100: ${scorecard.releaseStatus}`, right.x + 8, totalY + 20, { width: right.w - 16 })

  doc.moveTo(right.x + 6, right.y + 548).lineTo(right.x + right.w - 6, right.y + 548).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(11).text("SIGN-OFF", right.x + 8, right.y + 556)
  const signRows = [
    ["Fabricator", "_____________________", "Date", "__________"],
    ["QA Inspector", "_____________________", "Date", "__________"],
    ["Customer", "_____________________", "Date", "__________"]
  ]
  signRows.forEach((row, i) => {
    const y = right.y + 580 + i * 24
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(palette.thin).text(row[0], right.x + 8, y)
    doc.font("Helvetica").fontSize(8.5).fillColor(palette.ink).text(row[1], right.x + 80, y)
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(palette.thin).text(row[2], right.x + 340, y)
    doc.font("Helvetica").fontSize(8.5).fillColor(palette.ink).text(row[3], right.x + 380, y)
  })

  const noteLines = uniqueStrings([
    ...(projectData.callouts || []),
    documentMeta && documentMeta.docId
      ? `Document ${documentMeta.docId} Rev ${documentMeta.revision} v${documentMeta.version}`
      : "",
    "Critical joints listed in weld schedule must be welded before cosmetic passes.",
    "Hold dimensions from datums A/B and verify before final assembly release."
  ], 5)
  doc.moveTo(right.x + 6, right.y + 658).lineTo(right.x + right.w - 6, right.y + 658).strokeColor(palette.thin).lineWidth(0.8).stroke()
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(10).text("CRITICAL NOTES", right.x + 8, right.y + 666)
  noteLines.forEach((line, i) => {
    doc.font("Helvetica").fontSize(8.2).fillColor(palette.ink).text(`${i + 1}. ${line}`, right.x + 8, right.y + 686 + i * 13, { width: right.w - 16 })
  })

  doc.fillColor(palette.thin).font("Helvetica").fontSize(9).text(
    "QA RELEASE REQUIRES ALL CHECKBOXES COMPLETE AND SIGNATURES RECORDED.",
    shell.margin + 12,
    shell.PH - 24,
    { width: shell.PW - 120 }
  )
}

function payloadSafeGasLabel(process, gas) {
  if (process === "Flux Core") return "None / Self-shielded"
  return sanitizeText(gas, 40) || "As specified"
}

function drawBlueprint(doc, payload) {
  const { project, dimensions, welder, process, wire, wiresize, gas, thickness } = payload
  const { L, W, H } = dimensions
  const projectData = defaultProjectData(project, L, W, H)
  const projectMeta = blueprintGallery[project] || {}
  const ws = getWeldSettings(thickness, process)
  const documentMeta = buildBlueprintDocumentMeta({
    project,
    dimensions,
    process,
    wire,
    wiresize,
    gas,
    thickness
  })
  const PW = 1190
  const PH = 842
  const C = {
    paper: "#E8E4CF",
    ink: "#2E3640",
    thin: "#808890",
    grid: "#D5D0BC"
  }

  doc.rect(0, 0, PW, PH).fill(C.paper)
  for (let x = 0; x <= PW; x += 40) doc.moveTo(x, 0).lineTo(x, PH).strokeColor(C.grid).lineWidth(0.5).stroke()
  for (let y = 0; y <= PH; y += 40) doc.moveTo(0, y).lineTo(PW, y).strokeColor(C.grid).lineWidth(0.5).stroke()

  const margin = 24
  doc.rect(margin, margin, PW - margin * 2, PH - margin * 2).strokeColor(C.ink).lineWidth(1.2).stroke()
  doc.rect(margin + 10, margin + 10, PW - (margin + 10) * 2, PH - (margin + 10) * 2).strokeColor(C.thin).lineWidth(0.8).stroke()

  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(24).text(project.toUpperCase(), 0, 30, { width: PW, align: "center" })
  doc.fillColor(C.thin).font("Helvetica-Oblique").fontSize(11).text("WELDBLUEPRINTS AI - FABRICATION DRAWING", 0, 60, { width: PW, align: "center" })

  const frontBox = { x: 120, y: 140, w: 360, h: 220 }
  const sideBox = { x: 540, y: 140, w: 200, h: 220 }
  const isoBox = { x: 780, y: 95, w: 290, h: 240 }
  const topBox = { x: 120, y: 390, w: 450, h: 250 }
  const partBox = { x: 600, y: 390, w: 470, h: 250 }
  const titleBox = { x: 600, y: 655, w: 470, h: 150 }
  const style = getProjectStyle(project)
  const visual = projectData.visual || {}
  const visualProfile = {
    frontDivisions: clampNumber(visual.frontDivisions || 3, 2, 6),
    sideDivisions: clampNumber(visual.sideDivisions || 3, 2, 6),
    topGridCols: clampNumber(visual.topGridCols || 3, 2, 6),
    topGridRows: clampNumber(visual.topGridRows || 2, 2, 5),
    bracePattern: ["X", "V", "K"].includes(String(visual.bracePattern || "").toUpperCase()) ? String(visual.bracePattern).toUpperCase() : "none",
    shelfBands: clampNumber(visual.shelfBands || 0, 0, 4),
    centerOpening: !!visual.centerOpening,
    archTop: !!visual.archTop,
    wheelCount: clampNumber(visual.wheelCount || 0, 0, 4),
    isoStruts: clampNumber(visual.isoStruts || 2, 2, 5)
  }
  const featureCallouts = Array.isArray(projectData.callouts) ? projectData.callouts.slice(0, 3) : []

  ;[frontBox, sideBox, isoBox, topBox, partBox, titleBox].forEach(b => {
    doc.rect(b.x, b.y, b.w, b.h).strokeColor(C.thin).lineWidth(0.8).stroke()
  })

  const pxPerIn = Math.min((frontBox.w - 80) / Math.max(L, 1), (frontBox.h - 70) / Math.max(H, 1))
  const wPx = L * pxPerIn
  const hPx = H * pxPerIn
  const depthPx = W * pxPerIn

  const fx = frontBox.x + (frontBox.w - wPx) / 2
  const fy = frontBox.y + frontBox.h - 40
  if (style === "cage") {
    const rearW = wPx * 0.78
    const rearX = fx + (wPx - rearW) / 2
    const rearTopY = fy - hPx * 0.88
    doc.moveTo(rearX, fy).lineTo(rearX, rearTopY).strokeColor(C.ink).lineWidth(1.5).stroke()
    doc.moveTo(rearX + rearW, fy).lineTo(rearX + rearW, rearTopY).strokeColor(C.ink).lineWidth(1.5).stroke()
    doc.moveTo(rearX, rearTopY).lineTo(rearX + rearW, rearTopY).strokeColor(C.ink).lineWidth(1.5).stroke()
    const frontW = wPx * 0.56
    const frontX = fx + (wPx - frontW) / 2
    const frontTopY = fy - hPx * 0.70
    doc.moveTo(frontX, fy).lineTo(frontX, frontTopY).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.moveTo(frontX + frontW, fy).lineTo(frontX + frontW, frontTopY).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.moveTo(frontX, frontTopY).lineTo(frontX + frontW, frontTopY).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.moveTo(rearX, rearTopY).lineTo(frontX, frontTopY).strokeColor(C.thin).lineWidth(1).stroke()
    doc.moveTo(rearX + rearW, rearTopY).lineTo(frontX + frontW, frontTopY).strokeColor(C.thin).lineWidth(1).stroke()
    doc.moveTo(rearX + rearW * 0.2, fy - hPx * 0.45).lineTo(frontX + frontW * 0.2, fy - hPx * 0.35).strokeColor(C.thin).lineWidth(1).stroke()
    doc.moveTo(rearX + rearW * 0.8, fy - hPx * 0.45).lineTo(frontX + frontW * 0.8, fy - hPx * 0.35).strokeColor(C.thin).lineWidth(1).stroke()
  } else if (style === "trailer" || style === "flatbed" || style === "rack" || style === "skid") {
    const deckH = hPx * 0.35
    doc.rect(fx, fy - deckH, wPx, deckH).strokeColor(C.ink).lineWidth(1.6).stroke()
    for (let i = 1; i < 5; i += 1) {
      const x = fx + (wPx / 5) * i
      doc.moveTo(x, fy - deckH).lineTo(x, fy).strokeColor(C.thin).lineWidth(0.8).stroke()
    }
    if (style === "trailer" || style === "flatbed") {
      doc.circle(fx + wPx * 0.25, fy + 12, 10).strokeColor(C.ink).lineWidth(1.2).stroke()
      doc.circle(fx + wPx * 0.75, fy + 12, 10).strokeColor(C.ink).lineWidth(1.2).stroke()
    }
  } else if (style === "hoist") {
    doc.moveTo(fx + wPx * 0.1, fy).lineTo(fx + wPx * 0.9, fy).strokeColor(C.ink).lineWidth(1.6).stroke()
    doc.moveTo(fx + wPx * 0.5, fy).lineTo(fx + wPx * 0.5, fy - hPx * 0.88).strokeColor(C.ink).lineWidth(2).stroke()
    doc.moveTo(fx + wPx * 0.5, fy - hPx * 0.88).lineTo(fx + wPx * 0.92, fy - hPx * 0.78).strokeColor(C.ink).lineWidth(1.6).stroke()
    doc.moveTo(fx + wPx * 0.5, fy - hPx * 0.45).lineTo(fx + wPx * 0.2, fy - hPx * 0.08).strokeColor(C.thin).lineWidth(1).stroke()
  } else if (style === "lift") {
    const yLow = fy - hPx * 0.25
    const yTop = fy - hPx * 0.72
    doc.rect(fx + wPx * 0.1, yTop - 10, wPx * 0.8, 10).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.rect(fx + wPx * 0.1, yLow, wPx * 0.8, 10).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.moveTo(fx + wPx * 0.2, yLow + 10).lineTo(fx + wPx * 0.8, yTop).strokeColor(C.ink).lineWidth(1.4).stroke()
    doc.moveTo(fx + wPx * 0.8, yLow + 10).lineTo(fx + wPx * 0.2, yTop).strokeColor(C.ink).lineWidth(1.4).stroke()
  } else {
    doc.rect(fx, fy - hPx, wPx, hPx).strokeColor(C.ink).lineWidth(1.6).stroke()
    doc.moveTo(fx + wPx * 0.5, fy - hPx).lineTo(fx + wPx * 0.5, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(fx + wPx * 0.15, fy - hPx * 0.55).lineTo(fx + wPx * 0.85, fy - hPx * 0.55).strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  let frontBodyTopY = fy - hPx
  if (style === "cage") frontBodyTopY = fy - hPx * 0.88
  if (style === "trailer" || style === "flatbed" || style === "rack" || style === "skid") frontBodyTopY = fy - hPx * 0.35
  if (style === "hoist") frontBodyTopY = fy - hPx * 0.88
  if (style === "lift") frontBodyTopY = fy - hPx * 0.72

  for (let i = 1; i < visualProfile.frontDivisions; i += 1) {
    const x = fx + (wPx / visualProfile.frontDivisions) * i
    doc.moveTo(x, frontBodyTopY).lineTo(x, fy).strokeColor(C.grid).lineWidth(0.7).stroke()
  }

  for (let i = 1; i <= visualProfile.shelfBands; i += 1) {
    const y = frontBodyTopY + ((fy - frontBodyTopY) / (visualProfile.shelfBands + 1)) * i
    doc.moveTo(fx, y).lineTo(fx + wPx, y).strokeColor(C.grid).lineWidth(0.7).stroke()
  }

  if (visualProfile.bracePattern === "X") {
    doc.moveTo(fx, frontBodyTopY).lineTo(fx + wPx, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(fx + wPx, frontBodyTopY).lineTo(fx, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
  } else if (visualProfile.bracePattern === "V") {
    doc.moveTo(fx, frontBodyTopY).lineTo(fx + wPx * 0.5, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(fx + wPx, frontBodyTopY).lineTo(fx + wPx * 0.5, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
  } else if (visualProfile.bracePattern === "K") {
    const midX = fx + wPx * 0.5
    const midY = frontBodyTopY + (fy - frontBodyTopY) * 0.5
    doc.moveTo(midX, frontBodyTopY).lineTo(midX, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(midX, midY).lineTo(fx, frontBodyTopY).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(midX, midY).lineTo(fx + wPx, fy).strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  if (visualProfile.centerOpening && wPx > 40 && (fy - frontBodyTopY) > 30) {
    const openingW = wPx * 0.28
    const openingH = (fy - frontBodyTopY) * 0.42
    const openingX = fx + (wPx - openingW) / 2
    const openingY = frontBodyTopY + (fy - frontBodyTopY) * 0.28
    doc.rect(openingX, openingY, openingW, openingH).strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  if (visualProfile.archTop && wPx > 40) {
    const left = { x: fx + wPx * 0.1, y: frontBodyTopY + 4 }
    const right = { x: fx + wPx * 0.9, y: frontBodyTopY + 4 }
    const control = { x: fx + wPx * 0.5, y: frontBodyTopY - Math.max(8, hPx * 0.12) }
    doc.moveTo(left.x, left.y)
      .quadraticCurveTo(control.x, control.y, right.x, right.y)
      .strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  if (visualProfile.wheelCount >= 2 && style !== "trailer" && style !== "flatbed") {
    const slots = visualProfile.wheelCount === 2 ? [0.25, 0.75] : [0.12, 0.38, 0.62, 0.88]
    slots.slice(0, visualProfile.wheelCount).forEach(ratio => {
      doc.circle(fx + wPx * ratio, fy + 10, 6).strokeColor(C.ink).lineWidth(1).stroke()
    })
  }

  const sx = sideBox.x + (sideBox.w - depthPx) / 2
  const sy = sideBox.y + sideBox.h - 40
  if (style === "cage") {
    const topY = sy - hPx * 0.75
    doc.moveTo(sx + depthPx * 0.15, sy).lineTo(sx + depthPx * 0.15, topY).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(sx + depthPx * 0.85, sy).lineTo(sx + depthPx * 0.85, topY + hPx * 0.12).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(sx + depthPx * 0.15, topY).lineTo(sx + depthPx * 0.85, topY + hPx * 0.12).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(sx + depthPx * 0.2, sy - hPx * 0.35).lineTo(sx + depthPx * 0.82, sy - hPx * 0.28).strokeColor(C.thin).lineWidth(1).stroke()
  } else if (style === "trailer" || style === "flatbed" || style === "rack" || style === "skid") {
    const deckH = hPx * 0.35
    doc.rect(sx, sy - deckH, depthPx, deckH).strokeColor(C.ink).lineWidth(1.5).stroke()
  } else if (style === "hoist") {
    doc.moveTo(sx + depthPx * 0.1, sy).lineTo(sx + depthPx * 0.9, sy).strokeColor(C.ink).lineWidth(1.5).stroke()
    doc.moveTo(sx + depthPx * 0.45, sy).lineTo(sx + depthPx * 0.45, sy - hPx * 0.85).strokeColor(C.ink).lineWidth(1.9).stroke()
    doc.moveTo(sx + depthPx * 0.45, sy - hPx * 0.85).lineTo(sx + depthPx * 0.9, sy - hPx * 0.7).strokeColor(C.ink).lineWidth(1.5).stroke()
  } else if (style === "lift") {
    const yLow = sy - hPx * 0.22
    const yTop = sy - hPx * 0.70
    doc.rect(sx + depthPx * 0.1, yTop - 8, depthPx * 0.8, 8).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.rect(sx + depthPx * 0.1, yLow, depthPx * 0.8, 8).strokeColor(C.ink).lineWidth(1.2).stroke()
    doc.moveTo(sx + depthPx * 0.2, yLow + 8).lineTo(sx + depthPx * 0.8, yTop).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(sx + depthPx * 0.8, yLow + 8).lineTo(sx + depthPx * 0.2, yTop).strokeColor(C.ink).lineWidth(1.3).stroke()
  } else {
    doc.rect(sx, sy - hPx, depthPx, hPx).strokeColor(C.ink).lineWidth(1.6).stroke()
    doc.moveTo(sx + depthPx * 0.2, sy - hPx * 0.55).lineTo(sx + depthPx * 0.8, sy - hPx * 0.55).strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  let sideBodyTopY = sy - hPx
  if (style === "cage") sideBodyTopY = sy - hPx * 0.75
  if (style === "trailer" || style === "flatbed" || style === "rack" || style === "skid") sideBodyTopY = sy - hPx * 0.35
  if (style === "hoist") sideBodyTopY = sy - hPx * 0.85
  if (style === "lift") sideBodyTopY = sy - hPx * 0.70

  for (let i = 1; i < visualProfile.sideDivisions; i += 1) {
    const x = sx + (depthPx / visualProfile.sideDivisions) * i
    doc.moveTo(x, sideBodyTopY).lineTo(x, sy).strokeColor(C.grid).lineWidth(0.7).stroke()
  }

  if (visualProfile.bracePattern === "X" && depthPx > 20) {
    doc.moveTo(sx, sideBodyTopY).lineTo(sx + depthPx, sy).strokeColor(C.thin).lineWidth(0.8).stroke()
    doc.moveTo(sx + depthPx, sideBodyTopY).lineTo(sx, sy).strokeColor(C.thin).lineWidth(0.8).stroke()
  }

  const tx = topBox.x + (topBox.w - wPx) / 2
  const ty = topBox.y + (topBox.h + depthPx) / 2
  doc.rect(tx, ty - depthPx, wPx, depthPx).strokeColor(C.ink).lineWidth(1.6).stroke()
  const leg = Math.max(8, Math.min(16, depthPx * 0.12))
  if (style === "cage") {
    doc.moveTo(tx + wPx * 0.15, ty - depthPx * 0.2).lineTo(tx + wPx * 0.85, ty - depthPx * 0.2).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(tx + wPx * 0.2, ty - depthPx * 0.75).lineTo(tx + wPx * 0.8, ty - depthPx * 0.75).strokeColor(C.ink).lineWidth(1.3).stroke()
    doc.moveTo(tx + wPx * 0.2, ty - depthPx * 0.75).lineTo(tx + wPx * 0.15, ty - depthPx * 0.2).strokeColor(C.thin).lineWidth(1).stroke()
    doc.moveTo(tx + wPx * 0.8, ty - depthPx * 0.75).lineTo(tx + wPx * 0.85, ty - depthPx * 0.2).strokeColor(C.thin).lineWidth(1).stroke()
  } else {
    doc.rect(tx - leg / 2, ty - depthPx - leg / 2, leg, leg).strokeColor(C.thin).lineWidth(1).stroke()
    doc.rect(tx + wPx - leg / 2, ty - depthPx - leg / 2, leg, leg).strokeColor(C.thin).lineWidth(1).stroke()
    doc.rect(tx - leg / 2, ty - leg / 2, leg, leg).strokeColor(C.thin).lineWidth(1).stroke()
    doc.rect(tx + wPx - leg / 2, ty - leg / 2, leg, leg).strokeColor(C.thin).lineWidth(1).stroke()
  }

  for (let i = 1; i < visualProfile.topGridCols; i += 1) {
    const x = tx + (wPx / visualProfile.topGridCols) * i
    doc.moveTo(x, ty - depthPx).lineTo(x, ty).strokeColor(C.grid).lineWidth(0.7).stroke()
  }
  for (let i = 1; i < visualProfile.topGridRows; i += 1) {
    const y = ty - depthPx + (depthPx / visualProfile.topGridRows) * i
    doc.moveTo(tx, y).lineTo(tx + wPx, y).strokeColor(C.grid).lineWidth(0.7).stroke()
  }
  if (visualProfile.centerOpening && wPx > 50 && depthPx > 40) {
    const openW = wPx * 0.3
    const openD = depthPx * 0.34
    doc.rect(tx + (wPx - openW) / 2, ty - depthPx + (depthPx - openD) / 2, openW, openD).strokeColor(C.thin).lineWidth(0.9).stroke()
  }

  function ip(x, y, z, ox, oy, sxp = 0.9, syp = 0.45, szp = 1) {
    return { x: ox + (x - y) * sxp, y: oy + (x + y) * syp - z * szp }
  }
  const iScale = Math.min((isoBox.w - 80) / Math.max(L + W, 1), (isoBox.h - 70) / Math.max(H + W * 0.6, 1))
  const iox = isoBox.x + isoBox.w * 0.5
  const ioy = isoBox.y + isoBox.h * 0.78
  const pA = ip(0, 0, 0, iox, ioy, iScale, iScale * 0.5, iScale)
  const pB = ip(L, 0, 0, iox, ioy, iScale, iScale * 0.5, iScale)
  const pC = ip(L, W, 0, iox, ioy, iScale, iScale * 0.5, iScale)
  const pD = ip(0, W, 0, iox, ioy, iScale, iScale * 0.5, iScale)
  const pE = ip(0, 0, H, iox, ioy, iScale, iScale * 0.5, iScale)
  const pF = ip(L, 0, H, iox, ioy, iScale, iScale * 0.5, iScale)
  const pG = ip(L, W, H, iox, ioy, iScale, iScale * 0.5, iScale)
  const pH = ip(0, W, H, iox, ioy, iScale, iScale * 0.5, iScale)
  const ln = (a, b, w = 1.2, col = C.ink) => doc.moveTo(a.x, a.y).lineTo(b.x, b.y).strokeColor(col).lineWidth(w).stroke()
  if (style === "cage") {
    ln(pE, pF); ln(pF, pG); ln(pG, pH); ln(pH, pE, 1.2)
    ln(pA, pE); ln(pB, pF); ln(pC, pG); ln(pD, pH)
    const q1 = ip(L * 0.2, W * 0.25, H * 0.45, iox, ioy, iScale, iScale * 0.5, iScale)
    const q2 = ip(L * 0.8, W * 0.25, H * 0.45, iox, ioy, iScale, iScale * 0.5, iScale)
    const q3 = ip(L * 0.2, W * 0.75, H * 0.45, iox, ioy, iScale, iScale * 0.5, iScale)
    const q4 = ip(L * 0.8, W * 0.75, H * 0.45, iox, ioy, iScale, iScale * 0.5, iScale)
    ln(q1, q2, 1.1, C.thin); ln(q3, q4, 1.1, C.thin)
  } else if (style === "hoist") {
    const m1 = ip(L * 0.45, W * 0.5, 0, iox, ioy, iScale, iScale * 0.5, iScale)
    const m2 = ip(L * 0.45, W * 0.5, H * 0.9, iox, ioy, iScale, iScale * 0.5, iScale)
    const b1 = ip(L * 0.9, W * 0.2, H * 0.78, iox, ioy, iScale, iScale * 0.5, iScale)
    ln(pA, pB); ln(pB, pC); ln(pC, pD); ln(pD, pA)
    ln(m1, m2, 1.8); ln(m2, b1, 1.5)
  } else if (style === "trailer" || style === "flatbed") {
    ln(pA, pB); ln(pB, pC); ln(pC, pD); ln(pD, pA)
    ln(pE, pF, 1.2); ln(pF, pG, 1.2); ln(pG, pH, 1.2); ln(pH, pE, 1.2)
    const wh1 = ip(L * 0.25, -W * 0.06, 0, iox, ioy, iScale, iScale * 0.5, iScale)
    const wh2 = ip(L * 0.75, -W * 0.06, 0, iox, ioy, iScale, iScale * 0.5, iScale)
    doc.circle(wh1.x, wh1.y + 8, 7).strokeColor(C.ink).lineWidth(1).stroke()
    doc.circle(wh2.x, wh2.y + 8, 7).strokeColor(C.ink).lineWidth(1).stroke()
  } else {
    ln(pA, pB); ln(pB, pC); ln(pC, pD); ln(pD, pA)
    ln(pE, pF); ln(pF, pG); ln(pG, pH); ln(pH, pE)
    ln(pA, pE); ln(pB, pF); ln(pC, pG); ln(pD, pH)
  }

  for (let i = 1; i <= visualProfile.isoStruts; i += 1) {
    const t = i / (visualProfile.isoStruts + 1)
    const r1 = ip(L * t, 0, H * 0.2, iox, ioy, iScale, iScale * 0.5, iScale)
    const r2 = ip(L * t, W, H * 0.2, iox, ioy, iScale, iScale * 0.5, iScale)
    ln(r1, r2, 0.8, C.grid)
  }

  if (featureCallouts.length) {
    doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(8).text("KEY FEATURES", frontBox.x + 8, frontBox.y + 8)
    featureCallouts.forEach((line, i) => {
      doc.fillColor(C.thin).font("Helvetica").fontSize(7.5).text(`${i + 1}. ${sanitizeText(line, 60)}`, frontBox.x + 8, frontBox.y + 18 + i * 9, { width: frontBox.w - 16 })
    })
  }

  function dimH(x1, x2, y, text) {
    doc.moveTo(x1, y).lineTo(x2, y).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(x1, y - 5).lineTo(x1, y + 5).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(x2, y - 5).lineTo(x2, y + 5).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.fillColor(C.ink).font("Helvetica").fontSize(10).text(text, (x1 + x2) / 2 - 22, y - 14, { width: 44, align: "center" })
  }
  function dimV(y1, y2, x, text) {
    doc.moveTo(x, y1).lineTo(x, y2).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(x - 5, y1).lineTo(x + 5, y1).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.moveTo(x - 5, y2).lineTo(x + 5, y2).strokeColor(C.thin).lineWidth(0.9).stroke()
    doc.fillColor(C.ink).font("Helvetica").fontSize(10).text(text, x + 8, (y1 + y2) / 2 - 6)
  }

  dimH(fx, fx + wPx, fy + 26, `${L.toFixed(0)}"`)
  dimV(fy - hPx, fy, fx - 24, `${H.toFixed(0)}"`)
  dimH(sx, sx + depthPx, sy + 26, `${W.toFixed(0)}"`)

  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("FRONT", frontBox.x + frontBox.w / 2 - 20, frontBox.y + frontBox.h - 18)
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("SIDE", sideBox.x + sideBox.w / 2 - 14, sideBox.y + sideBox.h - 18)
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("TOP", topBox.x + topBox.w / 2 - 12, topBox.y + topBox.h - 18)
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("ISOMETRIC", isoBox.x + isoBox.w / 2 - 28, isoBox.y + isoBox.h - 18)

  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(11).text("PARTS LIST", partBox.x + 8, partBox.y + 8)
  const col = [partBox.x + 8, partBox.x + 42, partBox.x + 258, partBox.x + 292, partBox.x + 358]
  doc.font("Helvetica-Bold").fontSize(9)
  doc.text("ITEM", col[0], partBox.y + 26)
  doc.text("PART", col[1], partBox.y + 26)
  doc.text("QTY", col[2], partBox.y + 26)
  doc.text("LEN", col[3], partBox.y + 26)
  doc.text("MATERIAL", col[4], partBox.y + 26)
  doc.moveTo(partBox.x + 6, partBox.y + 40).lineTo(partBox.x + partBox.w - 6, partBox.y + 40).strokeColor(C.thin).lineWidth(0.8).stroke()

  const rows = projectData.parts.slice(0, 7)
  rows.forEach((r, i) => {
    const yy = partBox.y + 46 + i * 22
    doc.font("Helvetica").fontSize(8.5).fillColor(C.ink)
    doc.text(String(r[0]), col[0], yy)
    doc.text(String(r[1]).slice(0, 33), col[1], yy)
    doc.text(String(r[2]), col[2], yy)
    doc.text(String(r[3]).slice(0, 11), col[3], yy)
    doc.text(String(r[4]).slice(0, 18), col[4], yy)
    doc.moveTo(partBox.x + 6, yy + 16).lineTo(partBox.x + partBox.w - 6, yy + 16).strokeColor(C.grid).lineWidth(0.6).stroke()
  })

  const notesHeaderY = partBox.y + 202
  const notesBodyY = notesHeaderY + 13
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("BUILD NOTES", partBox.x + 8, notesHeaderY)
  doc.font("Helvetica").fontSize(8.5)
  const buildNotes = []
  if (projectMeta.description) buildNotes.push(`Project focus: ${projectMeta.description}`)
  if (projectData.featureSummary) buildNotes.push(`Feature profile: ${projectData.featureSummary}`)
  if (projectMeta.difficulty || projectMeta.time) {
    const difficulty = projectMeta.difficulty || "General"
    const time = projectMeta.time || "Varies"
    buildNotes.push(`Difficulty/Time: ${difficulty} / ${time}`)
  }
  projectData.steps.forEach(step => buildNotes.push(step))
  buildNotes.slice(0, 4).forEach((s, i) => {
    doc.text(`${i + 1}. ${sanitizeText(s, 84)}`, partBox.x + 8, notesBodyY + i * 9, { width: partBox.w - 16 })
  })

  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("TITLE BLOCK", titleBox.x + 8, titleBox.y + 8)
  doc.moveTo(titleBox.x + 6, titleBox.y + 24).lineTo(titleBox.x + titleBox.w - 6, titleBox.y + 24).strokeColor(C.thin).lineWidth(0.8).stroke()
  const revisionBox = { x: titleBox.x + titleBox.w - 164, y: titleBox.y + 28, w: 154, h: titleBox.h - 34 }
  doc.moveTo(revisionBox.x - 8, titleBox.y + 24).lineTo(revisionBox.x - 8, titleBox.y + titleBox.h - 6).strokeColor(C.grid).lineWidth(0.8).stroke()
  doc.rect(revisionBox.x, revisionBox.y, revisionBox.w, revisionBox.h).strokeColor(C.grid).lineWidth(0.8).stroke()
  doc.font("Helvetica-Bold").fontSize(8).fillColor(C.thin).text("REVISION CONTROL", revisionBox.x + 6, revisionBox.y + 6, { width: revisionBox.w - 12 })
  doc.moveTo(revisionBox.x + 6, revisionBox.y + 20).lineTo(revisionBox.x + revisionBox.w - 6, revisionBox.y + 20).strokeColor(C.grid).lineWidth(0.8).stroke()
  const revisionRows = [
    ["REV", documentMeta.revision],
    ["VERSION", documentMeta.version],
    ["DOC ID", documentMeta.docId],
    ["ISSUED", documentMeta.issuedDate],
    ["TIME", documentMeta.issuedTime],
    ["RELEASE", documentMeta.releaseType]
  ]
  revisionRows.forEach((row, i) => {
    const yy = revisionBox.y + 26 + i * 14
    doc.font("Helvetica-Bold").fontSize(7.6).fillColor(C.thin).text(row[0], revisionBox.x + 6, yy)
    doc.font("Helvetica").fontSize(7.8).fillColor(C.ink).text(String(row[1]), revisionBox.x + 50, yy, { width: revisionBox.w - 56 })
  })

  const profileLine = `${projectMeta.category || "General"} / ${projectMeta.difficulty || "General"} / ${projectMeta.time || "Varies"}`
  const tb = [
    ["PROJECT", project],
    ["PROFILE", profileLine],
    ["DRAWING", `${project.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-assy`],
    ["SIZE", `${L} x ${W} x ${H} in`],
    ["WELDER", welder],
    ["PROCESS", `${process} / ${wire} ${wiresize} / ${gas}`],
    ["MATERIAL", projectData.material],
    ["FEATURES", projectData.featureSummary || style],
    ["THICKNESS", thickness],
    ["DATE", new Date().toLocaleDateString()],
    ["WELD SET", `${ws.volts}V  ${ws.wfs}  ${ws.amps}`]
  ]
  const rowStep = tb.length > 10 ? 11 : 12
  const mainValueWidth = Math.max(120, revisionBox.x - (titleBox.x + 90) - 8)
  tb.forEach((r, i) => {
    const yy = titleBox.y + 30 + i * rowStep
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.thin).text(r[0], titleBox.x + 8, yy)
    doc.font("Helvetica").fontSize(8.5).fillColor(C.ink).text(sanitizeText(r[1], 46), titleBox.x + 90, yy, { width: mainValueWidth })
  })

  doc.fillColor(C.thin).font("Helvetica").fontSize(9).text(
    `NOT FOR ENGINEERING CERTIFICATION - VERIFY ALL DIMENSIONS BEFORE CUTTING`,
    margin + 8,
    PH - 20,
    { width: PW - margin * 2 - 16, align: "center" }
  )

  const detailContext = {
    project,
    projectMeta,
    projectData,
    dimensions: { L, W, H },
    style,
    process,
    thickness,
    gas,
    ws,
    palette: C,
    documentMeta
  }
  drawFabricationPackagePage(doc, detailContext)
  drawWeldAndQaPage(doc, detailContext)
}

async function getPayPalAccessToken() {
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  })

  if (!response.ok) {
    throw new Error("Could not get PayPal access token")
  }

  const data = await response.json()
  return data.access_token
}

async function verifyPayPalOrder(orderID) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal credentials are missing")
  }

  const accessToken = await getPayPalAccessToken()
  const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}`, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  })

  if (!response.ok) {
    throw new Error("Could not verify PayPal order")
  }

  const order = await response.json()
  const unit = order.purchase_units && order.purchase_units[0]
  const amount = unit && unit.amount

  const validStatus = order.status === "COMPLETED" || order.status === "APPROVED"
  const validAmount = amount && amount.value === PRO_PRICE_USD && amount.currency_code === "USD"

  return {
    ok: !!(validStatus && validAmount),
    order
  }
}

app.get("/health", (req, res) => {
  trackEvent("health_check")
  res.json({
    ok: true,
    env: NODE_ENV,
    time: new Date().toISOString()
  })
})

app.post("/api/track", rateLimit("track", 120, 15 * 60 * 1000), (req, res) => {
  const allowed = new Set([
    "page_view_home",
    "page_view_login",
    "page_view_pricing",
    "generate_click",
    "generate_success",
    "generate_error",
    "payment_success",
    "payment_error"
  ])
  const event = sanitizeText(req.body && req.body.event, 80).toLowerCase()
  if (!event || !allowed.has(event)) {
    return res.status(400).json({ error: "Invalid analytics event" })
  }
  trackEvent(event)
  res.json({ success: true })
})

app.post("/api/auth/register", rateLimit("register", 10, 15 * 60 * 1000), async (req, res) => {
  const username = sanitizeText(req.body.username, 50)
  const email = normalizeEmail(req.body.email)
  const password = String(req.body.password || "")
  const welderModel = sanitizeText(req.body.welderModel, 60)
  const experience = sanitizeText(req.body.experience || "Beginner", 30)

  if (!username || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  if (!email.includes("@")) {
    return res.status(400).json({ error: "Invalid email" })
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "Password must be at least 8 characters" })
  }

  if (users.find(u => normalizeEmail(u.email) === email)) {
    return res.status(400).json({ error: "User already exists" })
  }

  const hashedPassword = await bcrypt.hash(password, 10)
  const user = {
    id: Date.now(),
    username,
    email,
    password: hashedPassword,
    welderModel,
    experience,
    isAdmin: false,
    isPro: false,
    createdAt: new Date().toISOString(),
    generationsUsed: 0,
    savedProjects: [],
    savedSettings: [],
    favorites: []
  }

  users.push(user)
  saveData()

  const token = signUser(user)
  req.session.userId = user.id

  res.json({
    success: true,
    token,
    user: makeSafeUser(user)
  })
})

app.post("/api/auth/login", rateLimit("login", 15, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body.email)
  const password = String(req.body.password || "")

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" })
  }

  const user = users.find(u => normalizeEmail(u.email) === email)
  if (!user) return res.status(400).json({ error: "User not found" })

  const validPassword = await bcrypt.compare(password, user.password)
  if (!validPassword) return res.status(400).json({ error: "Invalid password" })

  const token = signUser(user)
  req.session.userId = user.id

  res.json({
    success: true,
    token,
    user: makeSafeUser(user)
  })
})

app.get("/api/auth/me", authenticateToken, (req, res) => {
  const user = req.userRecord || findUserFromToken(req.user)
  if (!user) {
    return res.status(401).json({
      error: "session_stale",
      message: "Session no longer matches an existing account. Please sign in again."
    })
  }
  res.json({ user: makeSafeUser(user) })
})

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true })
  })
})

app.post("/api/projects/save", authenticateToken, (req, res) => {
  const user = req.userRecord || findUserFromToken(req.user)
  if (!user) return res.status(404).json({ error: "User not found" })

  const savedProject = {
    id: Date.now(),
    userId: req.user.id,
    project: sanitizeText(req.body.project, 80),
    dimensions: sanitizeText(req.body.dimensions, 40),
    welder: sanitizeText(req.body.welder, 80),
    process: sanitizeText(req.body.process, 40),
    settings: req.body.settings || {},
    notes: sanitizeText(req.body.notes, 500),
    savedAt: new Date().toISOString()
  }

  savedProjects.push(savedProject)
  user.savedProjects = user.savedProjects || []
  user.savedProjects.push(savedProject.id)
  saveData()

  res.json({ success: true, project: savedProject })
})

app.get("/api/projects/saved", authenticateToken, (req, res) => {
  const list = savedProjects.filter(p => sameUserId(p.userId, req.user.id))
  res.json({ projects: list })
})

app.delete("/api/projects/:id", authenticateToken, (req, res) => {
  const projectId = Number(req.params.id)
  const index = savedProjects.findIndex(p => p.id === projectId && sameUserId(p.userId, req.user.id))
  if (index === -1) return res.status(404).json({ error: "Project not found" })

  savedProjects.splice(index, 1)
  saveData()
  res.json({ success: true })
})

app.get("/api/welders", (req, res) => {
  const welderList = Object.keys(weldSettingsDB).map(name => ({
    name,
    manufacturer: weldSettingsDB[name].manufacturer,
    type: weldSettingsDB[name].type
  }))
  res.json(welderList)
})

app.post("/api/settings/add", rateLimit("settings-add", 20, 15 * 60 * 1000), (req, res) => {
  const user = tryAuthenticateToken(req)
  const welder = sanitizeText(req.body.welder, 80)
  const process = sanitizeText(req.body.process, 40)
  const thickness = sanitizeText(req.body.thickness, 20)
  const volts = sanitizeText(req.body.volts, 20)
  const wireSpeed = sanitizeText(req.body.wireSpeed, 20)
  const gas = sanitizeText(req.body.gas, 40)
  const technique = sanitizeText(req.body.technique, 80)
  const userName = sanitizeText(req.body.userName, 60) || "Anonymous"

  if (!welder || !process || !thickness) {
    return res.status(400).json({ error: "Welder, process, and thickness are required" })
  }

  if (!weldSettingsDB[welder]) {
    return res.status(404).json({ error: "Welder not found" })
  }

  const setting = {
    id: Date.now(),
    userId: user ? user.id : null,
    welder,
    process,
    thickness,
    volts,
    wireSpeed,
    gas,
    technique,
    userName,
    usedCount: 0,
    createdAt: new Date().toISOString()
  }

  savedSettings.push(setting)
  if (user) {
    user.savedSettings = user.savedSettings || []
    user.savedSettings.push(setting.id)
  }
  saveData()

  res.json({ success: true, setting })
})

app.get("/api/settings/saved", authenticateToken, (req, res) => {
  const list = savedSettings.filter(setting => sameUserId(setting.userId, req.user.id))
  res.json({ settings: list })
})

app.get("/api/settings/:welder", (req, res) => {
  const welder = req.params.welder
  if (!weldSettingsDB[welder]) {
    return res.status(404).json({ error: "Welder not found" })
  }

  const base = JSON.parse(JSON.stringify(weldSettingsDB[welder]))
  const communitySettings = savedSettings.filter(setting => setting.welder === welder)

  communitySettings.forEach(setting => {
    if (!base.settings[setting.process]) base.settings[setting.process] = {}
    base.settings[setting.process][setting.thickness] = {
      ...base.settings[setting.process][setting.thickness],
      ...(setting.volts ? { volts: setting.volts } : {}),
      ...(setting.wireSpeed ? { wireSpeed: setting.wireSpeed } : {}),
      ...(setting.gas ? { gas: setting.gas } : {}),
      technique: setting.technique || "Community submitted",
      rating: 5,
      votes: setting.usedCount || 1
    }
  })

  res.json(base)
})

app.delete("/api/settings/:id", authenticateToken, (req, res) => {
  const user = req.userRecord || findUserFromToken(req.user)
  if (!user) return res.status(404).json({ error: "User not found" })

  const settingId = Number(req.params.id)
  const index = savedSettings.findIndex(setting => setting.id === settingId)
  if (index === -1) return res.status(404).json({ error: "Setting not found" })

  const setting = savedSettings[index]
  if (!sameUserId(setting.userId, req.user.id) && !user.isAdmin) {
    return res.status(403).json({ error: "Forbidden" })
  }

  savedSettings.splice(index, 1)
  users.forEach(candidate => {
    if (Array.isArray(candidate.savedSettings)) {
      candidate.savedSettings = candidate.savedSettings.filter(id => !sameUserId(id, settingId))
    }
  })
  saveData()

  res.json({ success: true })
})

app.post("/api/settings/:id/used", (req, res) => {
  const settingId = Number(req.params.id)
  const setting = savedSettings.find(item => item.id === settingId)
  if (!setting) return res.status(404).json({ error: "Setting not found" })

  setting.usedCount = (setting.usedCount || 0) + 1
  saveData()
  res.json({ success: true, usedCount: setting.usedCount })
})

app.get("/api/gallery", (req, res) => {
  res.json(blueprintGallery)
})

app.post("/api/analyze-scrap", (req, res) => {
  const suggestions = analyzeScrap(req.body.scrap)
  res.json({ suggestions })
})

app.get("/api/subscription/status", authenticateToken, (req, res) => {
  const user = req.userRecord || findUserFromToken(req.user)
  if (!user) return res.status(404).json({ error: "User not found" })

  res.json({
    isPro: !!user.isPro,
    generationsUsed: user.generationsUsed || 0,
    generationsRemaining: user.isPro ? "unlimited" : Math.max(0, FREE_GENERATION_LIMIT - (user.generationsUsed || 0)),
    limit: FREE_GENERATION_LIMIT
  })
})

app.post("/api/subscription/activate", authenticateToken, rateLimit("subscribe", 10, 15 * 60 * 1000), async (req, res) => {
  const { orderID, payerID, payerEmail, amount } = req.body

  if (!orderID || !payerID) {
    trackEvent("payment_error")
    return res.status(400).json({
      error: "Invalid PayPal order data",
      supportEmail: SUPPORT_EMAIL
    })
  }

  const user = req.userRecord || findUserFromToken(req.user)
  if (!user) return res.status(404).json({ error: "User not found" })

  try {
    const verification = await verifyPayPalOrder(orderID)
    if (!verification.ok) {
      trackEvent("payment_error")
      return res.status(400).json({
        error: "PayPal order verification failed",
        message: `Verification failed. Contact ${SUPPORT_EMAIL} with your PayPal order ID.`,
        supportEmail: SUPPORT_EMAIL
      })
    }

    user.isPro = true
    user.proActivatedAt = new Date().toISOString()
    user.paypalOrderID = orderID
    user.paypalPayerID = payerID
    user.paypalEmail = sanitizeText(payerEmail, 120)
    user.amountPaid = String(amount || PRO_PRICE_USD)

    saveData("critical")
    trackEvent("payment_success")

    res.json({
      success: true,
      user: makeSafeUser(user)
    })
  } catch (err) {
    console.error("PayPal activation error:", err.message)
    trackEvent("payment_error")
    res.status(500).json({
      error: "Could not verify payment",
      message: `Please contact support at ${SUPPORT_EMAIL} with your PayPal order ID.`,
      supportEmail: SUPPORT_EMAIL
    })
  }
})

app.post("/generate-blueprint", rateLimit("blueprint", 30, 15 * 60 * 1000), (req, res) => {
  trackEvent("generate_click")
  const project = resolveProjectName(req.body.project)
  const welder = sanitizeText(req.body.welder, 80)
  const process = sanitizeText(req.body.process, 40)
  const wire = sanitizeText(req.body.wire, 40)
  const wiresize = sanitizeText(req.body.wiresize, 20)
  const gas = sanitizeText(req.body.gas, 40)
  const thickness = sanitizeText(req.body.thickness, 20)
  const dimensions = parseDimensions(req.body.dimensions)

  const allowedProcesses = ["MIG", "Flux Core", "TIG"]
  const allowedGas = ["C25", "100% CO2", "Argon", "None"]
  const allowedThickness = ["1/8", "3/16", "1/4", "1/2"]

  if (!project || !welder || !process || !wire || !wiresize || !gas || !thickness || !dimensions) {
    trackEvent("generate_error")
    return res.status(400).json({ error: "Missing or invalid blueprint fields" })
  }

  if (!isAllowedValue(process, allowedProcesses)) {
    trackEvent("generate_error")
    return res.status(400).json({ error: "Invalid process" })
  }

  if (!isAllowedValue(gas, allowedGas)) {
    trackEvent("generate_error")
    return res.status(400).json({ error: "Invalid gas" })
  }

  if (!isAllowedValue(thickness, allowedThickness)) {
    trackEvent("generate_error")
    return res.status(400).json({ error: "Invalid thickness" })
  }

  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]

  if (!token) {
    trackEvent("generate_error")
    return res.status(401).json({
      error: "login_required",
      message: "Please create a free account to generate blueprints.",
      loginUrl: "/login.html"
    })
  }

  let user = null
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    user = findUserFromToken(decoded)
  } catch (err) {
    trackEvent("generate_error")
    return res.status(403).json({ error: "Invalid token" })
  }

  if (!user) {
    trackEvent("generate_error")
    return res.status(401).json({
      error: "session_stale",
      message: "Session no longer matches an existing account. Please sign in again."
    })
  }

  const isPreview = req.query.preview === "1"
  const shouldCountGeneration = !user.isPro && !isPreview

  if (!user.isPro) {
    const used = user.generationsUsed || 0
    if (used >= FREE_GENERATION_LIMIT) {
      return res.status(403).json({
        error: "free_limit_reached",
        message: `Free plan limit of ${FREE_GENERATION_LIMIT} blueprints reached.`,
        upgradeUrl: "/pricing.html"
      })
    }
  }

  const doc = new PDFDocument({
    size: [1190, 842],
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  })

  let docEnded = false
  const safeEndDoc = () => {
    if (!docEnded) {
      docEnded = true
      doc.end()
    }
  }

  const filename = `${sanitizeFilename(project)}-blueprint.pdf`
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", isPreview ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`)

  doc.on("error", err => {
    console.error("PDF stream error:", err.message)
    trackEvent("generate_error")
    if (!res.headersSent) {
      res.status(500).json({ error: "PDF generation failed" })
    } else if (!res.writableEnded) {
      res.end()
    }
  })

  res.on("error", err => {
    console.error("Response error:", err.message)
  })

  doc.pipe(res)

  try {
    drawBlueprint(doc, {
      project,
      dimensions,
      welder,
      process,
      wire,
      wiresize,
      gas,
      thickness
    })
    if (shouldCountGeneration) {
      user.generationsUsed = (user.generationsUsed || 0) + 1
      saveData()
    }
    trackEvent("generate_success")
    safeEndDoc()
  } catch (err) {
    console.error("Blueprint draw error:", err.message)
    trackEvent("generate_error")
    try {
      if (!res.headersSent) {
        return res.status(500).json({ error: "Blueprint generation failed" })
      }
      if (!res.writableEnded) {
        res.end()
      }
    } catch (_) {}
  }
})

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({
    users: users.map(makeSafeUser),
    total: users.length
  })
})

app.post("/api/admin/users/:id/grant-pro", requireAdmin, (req, res) => {
  const user = users.find(u => u.id === Number(req.params.id))
  if (!user) return res.status(404).json({ error: "User not found" })
  user.isPro = true
  user.proActivatedAt = new Date().toISOString()
  user.paypalOrderID = "ADMIN_GRANTED"
  saveData()
  res.json({ success: true })
})

app.post("/api/admin/users/:id/revoke-pro", requireAdmin, (req, res) => {
  const user = users.find(u => u.id === Number(req.params.id))
  if (!user) return res.status(404).json({ error: "User not found" })
  user.isPro = false
  user.proActivatedAt = null
  saveData()
  res.json({ success: true })
})

app.post("/api/admin/users/:id/reset-generations", requireAdmin, (req, res) => {
  const user = users.find(u => u.id === Number(req.params.id))
  if (!user) return res.status(404).json({ error: "User not found" })
  user.generationsUsed = 0
  saveData()
  res.json({ success: true })
})

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const index = users.findIndex(u => u.id === id)
  if (index === -1) return res.status(404).json({ error: "User not found" })
  if (users[index].isAdmin) return res.status(403).json({ error: "Cannot delete admin" })

  users.splice(index, 1)
  saveData()
  res.json({ success: true })
})

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const totals = analytics.totals || {}
  const paidConversions = Number(totals.payment_success || 0)
  const generationFailures = Number(totals.generate_error || 0)
  const generationSuccesses = Number(totals.generate_success || 0)
  const generationAttempts = generationFailures + generationSuccesses
  const generationFailureRate = generationAttempts
    ? Number(((generationFailures / generationAttempts) * 100).toFixed(1))
    : 0

  res.json({
    totalUsers: users.length,
    proUsers: users.filter(u => u.isPro && !u.isAdmin).length,
    freeUsers: users.filter(u => !u.isPro && !u.isAdmin).length,
    totalGenerations: users.reduce((sum, u) => sum + (u.generationsUsed || 0), 0),
    revenue: users.filter(u => u.isPro && !u.isAdmin && u.paypalOrderID !== "ADMIN_GRANTED").length * 19.99,
    totalProjects: savedProjects.length,
    paidConversions,
    generationFailures,
    generationFailureRate
  })
})

app.get("/api/admin/analytics", requireAdmin, (req, res) => {
  res.json({
    supportEmail: SUPPORT_EMAIL,
    totals: analytics.totals || {},
    daily: analytics.daily || {}
  })
})

function sendJsonDownload(res, filename, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
  res.send(JSON.stringify(payload, null, 2))
}

app.get("/api/admin/export/users", requireAdmin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10)
  sendJsonDownload(res, `users-export-${stamp}.json`, {
    exportedAt: new Date().toISOString(),
    count: users.length,
    users
  })
})

app.get("/api/admin/export/projects", requireAdmin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10)
  sendJsonDownload(res, `projects-export-${stamp}.json`, {
    exportedAt: new Date().toISOString(),
    count: savedProjects.length,
    savedProjects
  })
})

app.get("/api/admin/export/analytics", requireAdmin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10)
  sendJsonDownload(res, `analytics-export-${stamp}.json`, {
    exportedAt: new Date().toISOString(),
    supportEmail: SUPPORT_EMAIL,
    analytics
  })
})

requireEnvForProd()
warnIfRiskyConfig()
loadData()
loadAnalytics()
createDataBackup("startup")
setInterval(() => createDataBackup("daily"), 24 * 60 * 60 * 1000).unref()

app.listen(PORT, async () => {
  await ensureAdmin()
  const validation = validateBlueprintCatalog()
  console.log(`WeldBlueprints AI running at ${APP_ORIGIN}`)
  console.log(`${Object.keys(blueprintGallery).length} projects in gallery`)
  console.log(`${users.length} users loaded`)
  console.log(`Blueprint validation: ${validation.total} projects, ${Object.keys(validation.styles).length} render styles`)
  if (validation.issues.length) {
    console.log(`Blueprint validation issues (${validation.issues.length}):`)
    validation.issues.forEach(issue => console.log(` - ${issue}`))
  } else {
    console.log("Blueprint validation: OK")
  }
})
