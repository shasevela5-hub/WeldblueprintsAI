require("dotenv").config()

const express = require("express")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const session = require("express-session")
const FileStoreFactory = require("session-file-store")
const PDFDocument = require("pdfkit")

const app = express()

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
const FREE_GENERATION_LIMIT = 3

app.use(cors({
  origin: APP_ORIGIN,
  credentials: true
}))

app.use(express.json({ limit: "1mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(__dirname))
const sessionDir = path.join(__dirname, "sessions")
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

const dataFile = path.join(__dirname, "data.json")
const backupDir = path.join(__dirname, "backups")
const analyticsFile = path.join(__dirname, "analytics.json")

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
    console.log("Loaded data.json")
  } catch (err) {
    console.error("Failed to load data.json:", err.message)
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
    console.error("Failed to load analytics.json:", err.message)
  }
}

function saveAnalytics() {
  try {
    fs.writeFileSync(analyticsFile, JSON.stringify(analytics, null, 2), "utf8")
  } catch (err) {
    console.error("Failed to save analytics.json:", err.message)
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
    next()
  })
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]
  if (!token) return res.status(401).json({ error: "No token" })

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" })
    const user = users.find(u => u.id === decoded.id)
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

  if (hasTube && hasCasters) suggestions.push({ name: "Welding Cart", confidence: "95%", materials: "Tubing for frame and casters", image: "ðŸ›’", time: "4 hours" })
  if (hasTube && hasPlate) suggestions.push({ name: "Shop Workbench", confidence: "88%", materials: "Tube frame and plate top", image: "ðŸ”¨", time: "6 hours" })
  if (hasPlate) suggestions.push({ name: "Fire Pit", confidence: "92%", materials: "Plate for sides", image: "ðŸ”¥", time: "3 hours" })
  if (hasTube && hasAngle) suggestions.push({ name: "Metal Shelving Unit", confidence: "85%", materials: "Tube uprights and angle supports", image: "ðŸ—„ï¸", time: "4 hours" })
  if (hasRound) suggestions.push({ name: "Planter Stand", confidence: "81%", materials: "Rod and tube stock", image: "ðŸŒ¿", time: "2 hours" })
  if (hasTube && hasChannel) suggestions.push({ name: "Welding Table", confidence: "82%", materials: "Tube frame and channel edging", image: "ðŸ—œï¸", time: "8 hours" })

  return suggestions.slice(0, 4)
}

function defaultProjectData(project, L, W, H) {
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

  if (map[project]) return map[project]

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

  return templates[category] || {
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
  }
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
  if (project === "ATV Roll Cage") return "cage"
  if (project === "Stair Railing") return "railing"
  if (project === "Greenhouse Frame") return "greenhouse"
  if (project === "Mezzanine Frame") return "mezzanine"
  if (project === "Carport Frame") return "carport"
  if (project === "Pergola Frame") return "pergola"
  if (project === "Raised Garden Bed") return "planter"
  if (project === "Truck Flatbed") return "flatbed"
  if (project === "Headache Rack" || project === "Truck Toolbox Rack" || project === "Pipe Rack") return "rack"
  if (project === "Industrial Bookshelf") return "bookshelf"
  if (project === "Wine Rack") return "winerack"
  if (project === "Welded Sculpture") return "sculpture"
  if (project === "Murphy Bed Frame") return "murphy"
  if (project === "Floating Wall Shelves") return "wallshelf"
  if (project === "Motorcycle Lift") return "lift"
  if (project === "Welding Cart") return "cart"
  if (project === "Welding Table" || project === "Shop Workbench") return "table"
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

function drawBlueprint(doc, payload) {
  const { project, dimensions, welder, process, wire, wiresize, gas, thickness } = payload
  const { L, W, H } = dimensions
  const projectData = defaultProjectData(project, L, W, H)
  const ws = getWeldSettings(thickness, process)

  const pageWidth = 1190
  const pageHeight = 842

  const colors = {
    bg: "#08131F",
    panel: "#102033",
    line: "#5AAEF0",
    text: "#F5F7FA",
    mute: "#A6BACD",
    accent: "#FF8A3D",
    warn: "#FFD166"
  }

  doc.rect(0, 0, pageWidth, pageHeight).fill(colors.bg)

  for (let x = 0; x <= pageWidth; x += 28) {
    doc.moveTo(x, 0).lineTo(x, pageHeight).strokeColor("rgba(255,255,255,0.04)").lineWidth(0.5).stroke()
  }
  for (let y = 0; y <= pageHeight; y += 28) {
    doc.moveTo(0, y).lineTo(pageWidth, y).strokeColor("rgba(255,255,255,0.04)").lineWidth(0.5).stroke()
  }

  doc.rect(0, 0, pageWidth, 58).fill(colors.panel)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(22).text("WELDBLUEPRINTS AI", 28, 18)
  doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(18).text(project.toUpperCase(), 0, 18, { align: "center", width: pageWidth })

  doc.fillColor(colors.mute).font("Helvetica").fontSize(8)
  doc.text(`Dims: ${L}" x ${W}" x ${H}"`, pageWidth - 260, 12)
  doc.text(`Welder: ${welder}`, pageWidth - 260, 24)
  doc.text(`Process: ${process} / ${wire} ${wiresize}`, pageWidth - 260, 36)

  const leftX = 24
  const leftY = 84
  const leftW = 720
  const leftH = 700

  const rightX = 762
  const rightY = 84
  const rightW = 404
  const rightH = 700

  doc.roundedRect(leftX, leftY, leftW, leftH, 14).strokeColor("#28425B").lineWidth(1).stroke()
  doc.roundedRect(rightX, rightY, rightW, rightH, 14).strokeColor("#28425B").lineWidth(1).stroke()

  function header(x, y, w, title) {
    doc.roundedRect(x, y, w, 26, 10).fill(colors.panel)
    doc.fillColor(colors.warn).font("Helvetica-Bold").fontSize(10).text(title.toUpperCase(), x + 12, y + 8)
  }

  const frontBox = { x: 42, y: 132, w: 320, h: 240 }
  const topBox = { x: 42, y: 410, w: 320, h: 180 }
  const sideBox = { x: 392, y: 132, w: 180, h: 240 }
  const isoBox = { x: 392, y: 410, w: 300, h: 240 }

  header(frontBox.x, frontBox.y - 34, frontBox.w, "Front Elevation")
  header(topBox.x, topBox.y - 34, topBox.w, "Top View")
  header(sideBox.x, sideBox.y - 34, sideBox.w, "Side View")
  header(isoBox.x, isoBox.y - 34, isoBox.w, "Isometric")

  function fitScale(boxW, boxH, actualW, actualH) {
    return Math.min((boxW - 40) / actualW, (boxH - 40) / actualH)
  }

  const frontScale = fitScale(frontBox.w, frontBox.h, L, H)
  const topScale = fitScale(topBox.w, topBox.h, L, W)
  const sideScale = fitScale(sideBox.w, sideBox.h, W, H)
  const scale = Math.min(frontScale, topScale, sideScale)

  function drawProjectView(box, actualW, actualH, style, viewName) {
    const w = actualW * scale
    const h = actualH * scale
    const x = box.x + (box.w - w) / 2
    const y = box.y + (box.h - h) / 2
    const leg = Math.max(6, scale * 1.5)

    doc.rect(x, y, w, h).strokeColor(colors.line).lineWidth(2).stroke()
    if (style === "trailer") {
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      const members = 5
      for (let i = 1; i < members; i += 1) {
        const mx = x + (w / members) * i
        doc.moveTo(mx, y + leg).lineTo(mx, y + h - leg).strokeColor(colors.line).lineWidth(1.1).stroke()
      }
      if (viewName === "side") {
        const wheelR = Math.max(10, leg * 1.4)
        doc.circle(x + w * 0.28, y + h + wheelR * 0.4, wheelR).strokeColor(colors.line).lineWidth(1.2).stroke()
        doc.circle(x + w * 0.72, y + h + wheelR * 0.4, wheelR).strokeColor(colors.line).lineWidth(1.2).stroke()
      }
    } else if (style === "pit") {
      const wall = Math.max(8, leg * 1.6)
      doc.rect(x, y, w, wall).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - wall, w, wall).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, wall, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - wall, y, wall, h).fillAndStroke("#17314B", colors.line)
      doc.moveTo(x + wall, y + h * 0.5).lineTo(x + w - wall, y + h * 0.5).strokeColor(colors.line).lineWidth(1.0).stroke()
    } else if (style === "gate") {
      const pickets = 6
      for (let i = 1; i < pickets; i += 1) {
        const px = x + (w / pickets) * i
        doc.moveTo(px, y + leg).lineTo(px, y + h - leg).strokeColor(colors.line).lineWidth(1.1).stroke()
      }
      doc.moveTo(x + leg, y + h - leg).lineTo(x + w - leg, y + leg).strokeColor(colors.line).lineWidth(1.2).stroke()
    } else if (style === "furniture") {
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x + leg, y + h * 0.32, w - leg * 2, Math.max(4, leg * 0.7)).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      doc.moveTo(x + leg, y + h - leg).lineTo(x + w - leg, y + leg).strokeColor(colors.line).lineWidth(1).stroke()
    } else if (style === "shelf") {
      doc.rect(x, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - leg, y, leg, h).fillAndStroke("#17314B", colors.line)
      const levels = 4
      for (let i = 1; i < levels; i += 1) {
        const sy = y + (h / levels) * i
        doc.moveTo(x + leg, sy).lineTo(x + w - leg, sy).strokeColor(colors.line).lineWidth(1.1).stroke()
      }
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
    } else if (style === "struct") {
      const col = Math.max(8, leg * 1.8)
      doc.rect(x, y, col, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - col, y, col, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, w, col).fillAndStroke("#17314B", colors.line)
      if (h > col * 2) {
        doc.rect(x + col, y + h * 0.35, w - col * 2, Math.max(5, leg)).fillAndStroke("#17314B", colors.line)
        doc.rect(x + col, y + h * 0.65, w - col * 2, Math.max(5, leg)).fillAndStroke("#17314B", colors.line)
      }
      doc.moveTo(x + col, y + h - leg).lineTo(x + w - col, y + col).strokeColor(colors.line).lineWidth(1.1).stroke()
    } else if (style === "hoist") {
      const mast = Math.max(10, leg * 2)
      const boomY = y + h * 0.22
      const baseY = y + h - leg
      const mastX = x + w * 0.5 - mast / 2

      // H-base
      doc.rect(x + w * 0.15, baseY, w * 0.7, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.2, baseY - leg * 1.8, leg, leg * 1.8).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.8 - leg, baseY - leg * 1.8, leg, leg * 1.8).fillAndStroke("#17314B", colors.line)

      // Mast
      doc.rect(mastX, y + h * 0.18, mast, h * 0.72).fillAndStroke("#17314B", colors.line)

      // Boom and brace
      doc.moveTo(mastX + mast, boomY).lineTo(x + w * 0.88, y + h * 0.08).strokeColor(colors.line).lineWidth(3).stroke()
      doc.moveTo(mastX, y + h * 0.45).lineTo(x + w * 0.32, baseY).strokeColor(colors.line).lineWidth(1.4).stroke()

      // Hook chain
      doc.moveTo(x + w * 0.88, y + h * 0.08).lineTo(x + w * 0.88, y + h * 0.24).strokeColor(colors.warn).lineWidth(1.1).stroke()
      doc.circle(x + w * 0.88, y + h * 0.26, Math.max(3, leg * 0.4)).strokeColor(colors.warn).lineWidth(1).stroke()
    } else if (style === "cage") {
      const lwMain = 2.2
      const lwSec = 1.4
      if (viewName === "front") {
        // Main hoop front view
        doc.moveTo(x + w * 0.2, y + h).lineTo(x + w * 0.2, y + h * 0.34).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.8, y + h).lineTo(x + w * 0.8, y + h * 0.34).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.2, y + h * 0.34).lineTo(x + w * 0.5, y + h * 0.12).lineTo(x + w * 0.8, y + h * 0.34).strokeColor(colors.line).lineWidth(lwMain).stroke()
        // Shoulder and diagonal bars
        doc.moveTo(x + w * 0.28, y + h * 0.58).lineTo(x + w * 0.72, y + h * 0.58).strokeColor(colors.line).lineWidth(lwSec).stroke()
        doc.moveTo(x + w * 0.27, y + h * 0.86).lineTo(x + w * 0.73, y + h * 0.42).strokeColor(colors.line).lineWidth(lwSec).stroke()
      } else if (viewName === "side") {
        // Side profile hoop and rear brace
        doc.moveTo(x + w * 0.18, y + h).lineTo(x + w * 0.18, y + h * 0.44).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.62, y + h).lineTo(x + w * 0.62, y + h * 0.38).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.18, y + h * 0.44).lineTo(x + w * 0.42, y + h * 0.2).lineTo(x + w * 0.62, y + h * 0.38).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.62, y + h * 0.42).lineTo(x + w * 0.9, y + h * 0.62).strokeColor(colors.line).lineWidth(lwSec).stroke()
        doc.moveTo(x + w * 0.22, y + h * 0.75).lineTo(x + w * 0.58, y + h * 0.48).strokeColor(colors.line).lineWidth(lwSec).stroke()
      } else {
        // Top view: perimeter + roof cross bars
        doc.rect(x + w * 0.16, y + h * 0.2, w * 0.68, h * 0.58).strokeColor(colors.line).lineWidth(lwMain).stroke()
        doc.moveTo(x + w * 0.3, y + h * 0.22).lineTo(x + w * 0.3, y + h * 0.76).strokeColor(colors.line).lineWidth(lwSec).stroke()
        doc.moveTo(x + w * 0.5, y + h * 0.22).lineTo(x + w * 0.5, y + h * 0.76).strokeColor(colors.line).lineWidth(lwSec).stroke()
        doc.moveTo(x + w * 0.7, y + h * 0.22).lineTo(x + w * 0.7, y + h * 0.76).strokeColor(colors.line).lineWidth(lwSec).stroke()
        doc.moveTo(x + w * 0.18, y + h * 0.49).lineTo(x + w * 0.82, y + h * 0.49).strokeColor(colors.line).lineWidth(1).stroke()
      }
    } else if (style === "railing") {
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      const balusters = 8
      for (let i = 1; i < balusters; i += 1) {
        const bx = x + (w / balusters) * i
        doc.moveTo(bx, y + leg).lineTo(bx, y + h - leg).strokeColor(colors.line).lineWidth(1.1).stroke()
      }
    } else if (style === "greenhouse") {
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      const bays = 6
      for (let i = 0; i <= bays; i += 1) {
        const bx = x + (w / bays) * i
        doc.moveTo(bx, y + h - leg).lineTo(bx, y + h * 0.32).strokeColor(colors.line).lineWidth(1).stroke()
      }
      doc.moveTo(x, y + h * 0.32).lineTo(x + w * 0.5, y + h * 0.08).lineTo(x + w, y + h * 0.32).strokeColor(colors.line).lineWidth(1.8).stroke()
    } else if (style === "mezzanine") {
      const col = Math.max(8, leg * 1.6)
      doc.rect(x, y + h * 0.25, col, h * 0.75).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - col, y + h * 0.25, col, h * 0.75).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h * 0.25, w, col).fillAndStroke("#17314B", colors.line)
      doc.rect(x + col, y + h * 0.52, w - col * 2, Math.max(5, leg)).fillAndStroke("#17314B", colors.line)
      doc.rect(x + col, y + h * 0.74, w - col * 2, Math.max(5, leg * 0.8)).fillAndStroke("#17314B", colors.line)
    } else if (style === "carport" || style === "pergola") {
      const post = Math.max(8, leg * 1.5)
      doc.rect(x, y + h * 0.2, post, h * 0.8).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - post, y + h * 0.2, post, h * 0.8).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h * 0.2, w, post).fillAndStroke("#17314B", colors.line)
      if (style === "carport") {
        doc.moveTo(x, y + h * 0.2).lineTo(x + w * 0.5, y + h * 0.02).lineTo(x + w, y + h * 0.2).strokeColor(colors.line).lineWidth(1.5).stroke()
      } else {
        const rafters = 5
        for (let i = 1; i < rafters; i += 1) {
          const rx = x + (w / rafters) * i
          doc.moveTo(rx, y + h * 0.2).lineTo(rx, y + h * 0.35).strokeColor(colors.line).lineWidth(1).stroke()
        }
      }
    } else if (style === "planter") {
      const wall = Math.max(8, leg * 1.5)
      doc.rect(x, y + h - wall, w, wall).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h * 0.25, wall, h * 0.75).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - wall, y + h * 0.25, wall, h * 0.75).fillAndStroke("#17314B", colors.line)
      doc.moveTo(x + wall, y + h * 0.55).lineTo(x + w - wall, y + h * 0.55).strokeColor(colors.line).lineWidth(1).stroke()
    } else if (style === "flatbed") {
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg * 2.6, w, leg).fillAndStroke("#17314B", colors.line)
      const cross = 7
      for (let i = 1; i < cross; i += 1) {
        const cx = x + (w / cross) * i
        doc.moveTo(cx, y + h - leg * 2.6).lineTo(cx, y + h - leg).strokeColor(colors.line).lineWidth(1).stroke()
      }
    } else if (style === "rack") {
      const post = Math.max(8, leg * 1.4)
      doc.rect(x, y + h * 0.2, post, h * 0.8).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - post, y + h * 0.2, post, h * 0.8).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h * 0.2, w, post).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h * 0.6, w, post * 0.85).fillAndStroke("#17314B", colors.line)
    } else if (style === "bookshelf" || style === "winerack") {
      doc.rect(x, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - leg, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      const shelves = style === "bookshelf" ? 5 : 4
      for (let i = 1; i < shelves; i += 1) {
        const sy = y + (h / shelves) * i
        doc.moveTo(x + leg, sy).lineTo(x + w - leg, sy).strokeColor(colors.line).lineWidth(1.1).stroke()
      }
      if (style === "winerack") {
        for (let i = 1; i <= 3; i += 1) {
          const yy = y + (h * i) / 4
          doc.moveTo(x + w * 0.25, yy).lineTo(x + w * 0.75, yy).strokeColor(colors.warn).lineWidth(0.9).stroke()
        }
      }
    } else if (style === "sculpture") {
      doc.rect(x + w * 0.18, y + h - leg, w * 0.64, leg).fillAndStroke("#17314B", colors.line)
      doc.moveTo(x + w * 0.28, y + h - leg).lineTo(x + w * 0.44, y + h * 0.18).strokeColor(colors.line).lineWidth(1.7).stroke()
      doc.moveTo(x + w * 0.44, y + h * 0.18).lineTo(x + w * 0.68, y + h * 0.36).strokeColor(colors.line).lineWidth(1.7).stroke()
      doc.circle(x + w * 0.52, y + h * 0.14, Math.max(5, leg * 0.8)).strokeColor(colors.warn).lineWidth(1).stroke()
    } else if (style === "murphy") {
      // Wall frame + fold-down bed panel geometry
      const rail = Math.max(8, leg * 1.3)
      const panelW = w * 0.56
      const panelH = h * 0.72
      const panelX = x + w * 0.36
      const panelY = y + h * 0.2
      const pivotY = y + h * 0.83

      // Wall frame
      doc.rect(x + w * 0.04, y + h * 0.08, rail, h * 0.84).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.04, y + h * 0.08, w * 0.28, rail).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.04, y + h * 0.92 - rail, w * 0.28, rail).fillAndStroke("#17314B", colors.line)

      // Bed frame panel (shown tilted in side/front)
      doc.rect(panelX, panelY, panelW, panelH).strokeColor(colors.line).lineWidth(1.6).stroke()
      doc.moveTo(panelX + panelW * 0.15, panelY + panelH * 0.18).lineTo(panelX + panelW * 0.85, panelY + panelH * 0.82).strokeColor(colors.line).lineWidth(1).stroke()
      doc.moveTo(panelX + panelW * 0.15, panelY + panelH * 0.82).lineTo(panelX + panelW * 0.85, panelY + panelH * 0.18).strokeColor(colors.line).lineWidth(1).stroke()

      // Pivot points
      doc.circle(panelX + 4, pivotY, Math.max(3, rail * 0.32)).fillAndStroke(colors.warn, colors.line)
      doc.circle(panelX + panelW - 4, pivotY, Math.max(3, rail * 0.32)).fillAndStroke(colors.warn, colors.line)
    } else if (style === "wallshelf") {
      const plateW = Math.max(10, leg * 1.4)
      // Wall plates
      doc.rect(x + w * 0.08, y + h * 0.18, plateW, h * 0.64).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.46, y + h * 0.18, plateW, h * 0.64).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.84, y + h * 0.18, plateW, h * 0.64).fillAndStroke("#17314B", colors.line)
      // Hidden arms
      ;[0.08, 0.46, 0.84].forEach(pos => {
        const ax = x + w * pos + plateW
        doc.moveTo(ax, y + h * 0.35).lineTo(x + w * 0.97, y + h * 0.35).strokeColor(colors.line).lineWidth(1.6).stroke()
        doc.moveTo(ax, y + h * 0.6).lineTo(x + w * 0.97, y + h * 0.6).strokeColor(colors.line).lineWidth(1.6).stroke()
      })
      // Shelf body
      doc.rect(x + w * 0.18, y + h * 0.28, w * 0.76, h * 0.44).strokeColor(colors.warn).lineWidth(1).stroke()
    } else if (style === "lift") {
      const topY = y + h * 0.28
      const botY = y + h * 0.8
      const left = x + w * 0.14
      const right = x + w * 0.86
      const armW = Math.max(3, leg * 0.35)

      // Top and bottom decks
      doc.rect(left, topY, right - left, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(left, botY, right - left, leg).fillAndStroke("#17314B", colors.line)
      // Scissor arms
      doc.moveTo(left + armW, botY).lineTo(right - armW, topY + leg).strokeColor(colors.line).lineWidth(1.8).stroke()
      doc.moveTo(right - armW, botY).lineTo(left + armW, topY + leg).strokeColor(colors.line).lineWidth(1.8).stroke()
      // Pivot
      doc.circle((left + right) / 2, (topY + botY) / 2, Math.max(4, armW * 1.4)).strokeColor(colors.warn).lineWidth(1).stroke()
    } else if (style === "outdoor") {
      const wall = Math.max(7, leg * 1.3)
      doc.rect(x, y + h - wall, w, wall).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, wall, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - wall, y, wall, h).fillAndStroke("#17314B", colors.line)
      if (viewName === "top") {
        const slats = 5
        for (let i = 1; i < slats; i += 1) {
          const sx = x + (w / slats) * i
          doc.moveTo(sx, y + wall).lineTo(sx, y + h - wall).strokeColor(colors.line).lineWidth(0.9).stroke()
        }
      } else {
        doc.rect(x + wall, y + h * 0.4, w - wall * 2, Math.max(4, leg * 0.6)).fillAndStroke("#17314B", colors.line)
      }
    } else if (style === "table") {
      const topThk = Math.max(8, leg * 1.2)
      doc.rect(x, y, w, topThk).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, leg, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - leg, y + h - leg, leg, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x + leg, y + h * 0.45, w - leg * 2, Math.max(4, leg * 0.7)).fillAndStroke("#17314B", colors.line)
    } else if (style === "decor") {
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      const stems = 5
      for (let i = 0; i < stems; i += 1) {
        const sx = x + (w / (stems + 1)) * (i + 1)
        const sh = h * (0.35 + (i % 2) * 0.25)
        doc.moveTo(sx, y + h - leg).lineTo(sx, y + h - sh).strokeColor(colors.line).lineWidth(1.4).stroke()
      }
      doc.moveTo(x + leg, y + h * 0.4).lineTo(x + w - leg, y + h * 0.55).strokeColor(colors.line).lineWidth(0.9).stroke()
    } else if (style === "cart") {
      doc.rect(x, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - leg, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w * 0.72, y + h * 0.28, Math.max(8, leg * 1.2), h * 0.44).strokeColor(colors.line).lineWidth(1.1).stroke()
    } else {
      doc.rect(x, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x + w - leg, y, leg, h).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y, w, leg).fillAndStroke("#17314B", colors.line)
      doc.rect(x, y + h - leg, w, leg).fillAndStroke("#17314B", colors.line)
      if (h > 70) {
        doc.moveTo(x + leg, y + h * 0.42).lineTo(x + w - leg, y + h * 0.42).strokeColor(colors.line).lineWidth(1.2).stroke()
      }
    }

    doc.fillColor(colors.warn).font("Helvetica-Bold").fontSize(9)
    doc.text(`${actualW}"`, x + w / 2 - 18, y + h + 8)
    doc.text(`${actualH}"`, x - 24, y + h / 2 - 4)
  }

  const style = getProjectStyle(project)
  drawProjectView(frontBox, L, H, style, "front")
  drawProjectView(topBox, L, W, style, "top")
  drawProjectView(sideBox, W, H, style, "side")

  const isoBaseX = isoBox.x + 70
  const isoBaseY = isoBox.y + 170
  const isoScale = Math.min(isoBox.w / (L + W + 60), isoBox.h / (H + 60)) * 0.7

  function p3(x, y, z) {
    return {
      x: isoBaseX + (x - y) * 0.86 * isoScale,
      y: isoBaseY + (x + y) * 0.35 * isoScale - z * isoScale
    }
  }

  const A = p3(0, 0, 0)
  const B = p3(L, 0, 0)
  const C = p3(L, W, 0)
  const D = p3(0, W, 0)
  const E = p3(0, 0, H)
  const F = p3(L, 0, H)
  const G = p3(L, W, H)
  const H1 = p3(0, W, H)

  doc.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(C.x, C.y).lineTo(D.x, D.y).closePath().strokeColor(colors.line).lineWidth(2).stroke()
  doc.moveTo(E.x, E.y).lineTo(F.x, F.y).lineTo(G.x, G.y).lineTo(H1.x, H1.y).closePath().strokeColor(colors.line).lineWidth(2).stroke()
  doc.moveTo(A.x, A.y).lineTo(E.x, E.y).strokeColor(colors.line).lineWidth(2).stroke()
  doc.moveTo(B.x, B.y).lineTo(F.x, F.y).strokeColor(colors.line).lineWidth(2).stroke()
  doc.moveTo(C.x, C.y).lineTo(G.x, G.y).strokeColor(colors.line).lineWidth(2).stroke()
  doc.moveTo(D.x, D.y).lineTo(H1.x, H1.y).strokeColor(colors.line).lineWidth(2).stroke()

  // Style-specific iso details so different projects are visually distinct
  if (style === "trailer") {
    const wheelR = Math.max(8, isoScale * 6)
    doc.circle((A.x + B.x) / 2 - 40, A.y + 20, wheelR).strokeColor(colors.line).lineWidth(1.2).stroke()
    doc.circle((A.x + B.x) / 2 + 40, A.y + 20, wheelR).strokeColor(colors.line).lineWidth(1.2).stroke()
  } else if (style === "pit") {
    doc.moveTo(E.x + 10, E.y + 6).lineTo(F.x - 10, F.y + 6).strokeColor(colors.warn).lineWidth(1.1).stroke()
    doc.moveTo(H1.x + 8, H1.y + 4).lineTo(G.x - 8, G.y + 4).strokeColor(colors.warn).lineWidth(1.1).stroke()
  } else if (style === "gate") {
    doc.moveTo(A.x, A.y).lineTo(F.x, F.y).strokeColor(colors.line).lineWidth(1.1).stroke()
    doc.moveTo(B.x, B.y).lineTo(E.x, E.y).strokeColor(colors.line).lineWidth(1.1).stroke()
  } else if (style === "struct") {
    const mid1 = p3(0, 0, H * 0.35)
    const mid2 = p3(L, W, H * 0.35)
    const mid3 = p3(0, 0, H * 0.7)
    const mid4 = p3(L, W, H * 0.7)
    doc.moveTo(mid1.x, mid1.y).lineTo(mid2.x, mid2.y).strokeColor(colors.line).lineWidth(1).stroke()
    doc.moveTo(mid3.x, mid3.y).lineTo(mid4.x, mid4.y).strokeColor(colors.line).lineWidth(1).stroke()
  } else if (style === "hoist") {
    const mastTop = p3(L * 0.5, W * 0.5, H)
    const boomTip = p3(L * 0.95, W * 0.25, H * 0.95)
    const chainTop = p3(L * 0.95, W * 0.25, H * 0.95)
    const chainBottom = p3(L * 0.95, W * 0.25, H * 0.62)
    const brace1 = p3(L * 0.5, W * 0.5, H * 0.45)
    const brace2 = p3(L * 0.28, W * 0.2, H * 0.12)

    doc.moveTo(mastTop.x, mastTop.y).lineTo(boomTip.x, boomTip.y).strokeColor(colors.line).lineWidth(1.6).stroke()
    doc.moveTo(chainTop.x, chainTop.y).lineTo(chainBottom.x, chainBottom.y).strokeColor(colors.warn).lineWidth(1.1).stroke()
    doc.circle(chainBottom.x, chainBottom.y + 3, 3).strokeColor(colors.warn).lineWidth(1).stroke()
    doc.moveTo(brace1.x, brace1.y).lineTo(brace2.x, brace2.y).strokeColor(colors.line).lineWidth(1).stroke()
  } else if (style === "cage") {
    const baseA = p3(L * 0.15, W * 0.2, 0)
    const baseB = p3(L * 0.86, W * 0.2, 0)
    const baseC = p3(L * 0.86, W * 0.8, 0)
    const baseD = p3(L * 0.15, W * 0.8, 0)
    const topL = p3(L * 0.2, W * 0.25, H * 0.78)
    const topC = p3(L * 0.52, W * 0.5, H)
    const topR = p3(L * 0.84, W * 0.75, H * 0.78)
    const brace1 = p3(L * 0.24, W * 0.24, H * 0.18)
    const brace2 = p3(L * 0.76, W * 0.7, H * 0.76)
    const side1 = p3(L * 0.2, W * 0.8, H * 0.72)
    const side2 = p3(L * 0.82, W * 0.2, H * 0.72)

    doc.moveTo(baseA.x, baseA.y).lineTo(baseB.x, baseB.y).lineTo(baseC.x, baseC.y).lineTo(baseD.x, baseD.y).closePath().strokeColor(colors.line).lineWidth(1.1).stroke()
    doc.moveTo(baseA.x, baseA.y).lineTo(topL.x, topL.y).strokeColor(colors.line).lineWidth(1.5).stroke()
    doc.moveTo(baseB.x, baseB.y).lineTo(topC.x, topC.y).strokeColor(colors.line).lineWidth(1.5).stroke()
    doc.moveTo(baseC.x, baseC.y).lineTo(topR.x, topR.y).strokeColor(colors.line).lineWidth(1.5).stroke()
    doc.moveTo(topL.x, topL.y).lineTo(topC.x, topC.y).lineTo(topR.x, topR.y).strokeColor(colors.line).lineWidth(1.6).stroke()
    doc.moveTo(side1.x, side1.y).lineTo(side2.x, side2.y).strokeColor(colors.line).lineWidth(1.1).stroke()
    doc.moveTo(brace1.x, brace1.y).lineTo(brace2.x, brace2.y).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "railing") {
    for (let i = 1; i < 8; i += 1) {
      const p1 = p3((L / 8) * i, 0, H * 0.1)
      const p2 = p3((L / 8) * i, W, H * 0.88)
      doc.moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).strokeColor(colors.line).lineWidth(0.9).stroke()
    }
  } else if (style === "greenhouse") {
    const ridge1 = p3(0, W * 0.5, H)
    const ridge2 = p3(L, W * 0.5, H)
    doc.moveTo(ridge1.x, ridge1.y).lineTo(ridge2.x, ridge2.y).strokeColor(colors.warn).lineWidth(1.1).stroke()
  } else if (style === "mezzanine") {
    const lvl = p3(0, 0, H * 0.55)
    const lvl2 = p3(L, W, H * 0.55)
    doc.moveTo(lvl.x, lvl.y).lineTo(lvl2.x, lvl2.y).strokeColor(colors.line).lineWidth(1.1).stroke()
  } else if (style === "carport" || style === "pergola") {
    const ridge1 = p3(0, W * 0.5, H * 1.05)
    const ridge2 = p3(L, W * 0.5, H * 1.05)
    doc.moveTo(ridge1.x, ridge1.y).lineTo(ridge2.x, ridge2.y).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "planter") {
    const lip1 = p3(0, 0, H * 0.8)
    const lip2 = p3(L, W, H * 0.8)
    doc.moveTo(lip1.x, lip1.y).lineTo(lip2.x, lip2.y).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "flatbed") {
    const deck1 = p3(0, 0, H * 0.2)
    const deck2 = p3(L, W, H * 0.2)
    doc.moveTo(deck1.x, deck1.y).lineTo(deck2.x, deck2.y).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "rack") {
    const rail1 = p3(0, 0, H * 0.72)
    const rail2 = p3(L, W, H * 0.72)
    doc.moveTo(rail1.x, rail1.y).lineTo(rail2.x, rail2.y).strokeColor(colors.line).lineWidth(1).stroke()
  } else if (style === "bookshelf" || style === "winerack") {
    const levels = style === "bookshelf" ? [0.2, 0.4, 0.6, 0.8] : [0.3, 0.5, 0.7]
    levels.forEach(level => {
      const s1 = p3(0, 0, H * level)
      const s2 = p3(L, W, H * level)
      doc.moveTo(s1.x, s1.y).lineTo(s2.x, s2.y).strokeColor(colors.line).lineWidth(0.9).stroke()
    })
  } else if (style === "sculpture") {
    const spire = p3(L * 0.55, W * 0.5, H * 1.18)
    const base = p3(L * 0.45, W * 0.45, H * 0.4)
    doc.moveTo(base.x, base.y).lineTo(spire.x, spire.y).strokeColor(colors.warn).lineWidth(1.1).stroke()
    doc.circle(spire.x, spire.y, 3).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "murphy") {
    const wallTop1 = p3(0, 0, H)
    const wallTop2 = p3(0, W, H)
    const panel1 = p3(L * 0.35, W * 0.15, H * 0.85)
    const panel2 = p3(L * 0.92, W * 0.85, H * 0.18)
    doc.moveTo(wallTop1.x, wallTop1.y).lineTo(wallTop2.x, wallTop2.y).strokeColor(colors.line).lineWidth(1.2).stroke()
    doc.moveTo(panel1.x, panel1.y).lineTo(panel2.x, panel2.y).strokeColor(colors.warn).lineWidth(1.2).stroke()
  } else if (style === "wallshelf") {
    const s1 = p3(L * 0.22, W * 0.25, H * 0.45)
    const s2 = p3(L * 0.95, W * 0.75, H * 0.45)
    const s3 = p3(L * 0.22, W * 0.25, H * 0.62)
    const s4 = p3(L * 0.95, W * 0.75, H * 0.62)
    doc.moveTo(s1.x, s1.y).lineTo(s2.x, s2.y).strokeColor(colors.line).lineWidth(1.1).stroke()
    doc.moveTo(s3.x, s3.y).lineTo(s4.x, s4.y).strokeColor(colors.line).lineWidth(1.1).stroke()
  } else if (style === "lift") {
    const d1 = p3(L * 0.15, W * 0.15, H * 0.22)
    const d2 = p3(L * 0.9, W * 0.85, H * 0.22)
    const t1 = p3(L * 0.15, W * 0.15, H * 0.7)
    const t2 = p3(L * 0.9, W * 0.85, H * 0.7)
    doc.moveTo(d1.x, d1.y).lineTo(t2.x, t2.y).strokeColor(colors.line).lineWidth(1.5).stroke()
    doc.moveTo(d2.x, d2.y).lineTo(t1.x, t1.y).strokeColor(colors.line).lineWidth(1.5).stroke()
    const piv = p3(L * 0.52, W * 0.5, H * 0.46)
    doc.circle(piv.x, piv.y, 3).strokeColor(colors.warn).lineWidth(1).stroke()
  } else if (style === "outdoor") {
    doc.moveTo(A.x + 4, A.y - 8).lineTo(B.x - 4, B.y - 8).strokeColor(colors.warn).lineWidth(0.9).stroke()
    doc.moveTo(D.x + 4, D.y - 6).lineTo(C.x - 4, C.y - 6).strokeColor(colors.warn).lineWidth(0.9).stroke()
  } else if (style === "decor") {
    const pTop = p3(L * 0.5, W * 0.5, H * 1.2)
    doc.moveTo((E.x + F.x) / 2, (E.y + F.y) / 2).lineTo(pTop.x, pTop.y).strokeColor(colors.warn).lineWidth(1.2).stroke()
  }

  let cursorY = rightY + 12
  const panelX = rightX + 12
  const panelW = rightW - 24

  function sectionBox(title, bodyHeight) {
    header(panelX, cursorY, panelW, title)
    const bodyY = cursorY + 28
    doc.roundedRect(panelX, bodyY, panelW, bodyHeight, 8).strokeColor("#2A455E").lineWidth(0.9).stroke()
    const inner = { x: panelX + 10, y: bodyY + 8, w: panelW - 20, h: bodyHeight - 16, boxY: bodyY }
    cursorY = bodyY + bodyHeight + 10
    return inner
  }

  const weldRows = [
    ["PROCESS", process],
    ["FILLER", `${wire} ${wiresize}`],
    ["SHIELD GAS", gas],
    ["VOLTAGE", ws.volts],
    ["WIRE FEED", ws.wfs],
    ["AMPERAGE", ws.amps],
    ["TECHNIQUE", ws.technique],
    ["PREHEAT", ws.preheat],
    ["BASE MATERIAL", projectData.material]
  ]
  const weldBody = sectionBox("Weld Parameters", 196)
  const weldRowH = 18
  for (let i = 0; i < weldRows.length; i += 1) {
    const [label, value] = weldRows[i]
    const ry = weldBody.y + i * weldRowH
    if (i % 2 === 0) {
      doc.rect(weldBody.x, ry - 1, weldBody.w, weldRowH).fill("#0F1D2D")
    }
    doc.fillColor(colors.mute).font("Helvetica-Bold").fontSize(7.5).text(label, weldBody.x + 4, ry + 4, { width: 102 })
    doc.fillColor(colors.text).font("Helvetica").fontSize(9.4).text(String(value), weldBody.x + 108, ry + 3, { width: weldBody.w - 112 })
    doc.moveTo(weldBody.x, ry + weldRowH - 1).lineTo(weldBody.x + weldBody.w, ry + weldRowH - 1).strokeColor("#1F354B").lineWidth(0.5).stroke()
  }
  doc.moveTo(weldBody.x + 102, weldBody.y - 1).lineTo(weldBody.x + 102, weldBody.y + weldRows.length * weldRowH).strokeColor("#2A455E").lineWidth(0.8).stroke()

  const cutBody = sectionBox("Cut List", 176)
  const cols = {
    mark: cutBody.x,
    desc: cutBody.x + 26,
    qty: cutBody.x + 164,
    len: cutBody.x + 206,
    mat: cutBody.x + 268,
    end: cutBody.x + cutBody.w
  }
  const headY = cutBody.y
  const rowH = 20
  doc.rect(cutBody.x, headY, cutBody.w, rowH).fill("#15314A").strokeColor("#2A455E").lineWidth(0.8).stroke()
  doc.fillColor(colors.warn).font("Helvetica-Bold").fontSize(7.5)
  doc.text("MARK", cols.mark + 4, headY + 6, { width: 22 })
  doc.text("DESCRIPTION", cols.desc + 4, headY + 6, { width: 136 })
  doc.text("QTY", cols.qty + 4, headY + 6, { width: 36 })
  doc.text("LENGTH", cols.len + 4, headY + 6, { width: 58 })
  doc.text("MATERIAL", cols.mat + 4, headY + 6, { width: cutBody.end - cols.mat - 6 })

  ;[cols.desc, cols.qty, cols.len, cols.mat].forEach(x => {
    doc.moveTo(x, headY).lineTo(x, headY + rowH + rowH * projectData.parts.length).strokeColor("#2A455E").lineWidth(0.6).stroke()
  })

  projectData.parts.forEach((part, index) => {
    const [letter, name, qty, len, material] = part
    const y = headY + rowH * (index + 1)
    if (index % 2 === 0) doc.rect(cutBody.x, y, cutBody.w, rowH).fill("#0F1D2D")
    doc.fillColor(colors.warn).font("Helvetica-Bold").fontSize(9).text(letter, cols.mark + 8, y + 6, { width: 16, align: "center" })
    doc.fillColor(colors.text).font("Helvetica").fontSize(8.8).text(String(name), cols.desc + 4, y + 6, { width: cols.qty - cols.desc - 8 })
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(8.8).text(String(qty), cols.qty + 4, y + 6, { width: cols.len - cols.qty - 8, align: "center" })
    doc.fillColor(colors.line).font("Helvetica-Bold").fontSize(8.8).text(String(len), cols.len + 4, y + 6, { width: cols.mat - cols.len - 8, align: "center" })
    doc.fillColor(colors.mute).font("Helvetica").fontSize(8.3).text(String(material), cols.mat + 4, y + 6, { width: cutBody.end - cols.mat - 8 })
    doc.moveTo(cutBody.x, y + rowH).lineTo(cutBody.x + cutBody.w, y + rowH).strokeColor("#1F354B").lineWidth(0.5).stroke()
  })
  doc.rect(cutBody.x, headY, cutBody.w, rowH + rowH * projectData.parts.length).strokeColor("#2A455E").lineWidth(0.9).stroke()

  const stepBody = sectionBox("Build Sequence", 146)
  projectData.steps.slice(0, 6).forEach((step, index) => {
    const y = stepBody.y + index * 22
    doc.circle(stepBody.x + 10, y + 8, 7).fill(colors.accent)
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(7.5).text(String(index + 1), stepBody.x + 7.6, y + 5.1)
    doc.fillColor(colors.text).font("Helvetica").fontSize(9).text(step, stepBody.x + 24, y + 2, {
      width: stepBody.w - 28,
      lineGap: 1
    })
    if (index < 5) {
      doc.moveTo(stepBody.x + 24, y + 20).lineTo(stepBody.x + stepBody.w, y + 20).strokeColor("#1F354B").lineWidth(0.5).stroke()
    }
  })

  const notesBody = sectionBox("General Notes", 80)
  const notes = [
    "ALL DIMENSIONS ARE IN INCHES UNLESS NOTED.",
    "REMOVE BURRS/SHARP EDGES. BREAK CORNERS 1/32 TYP.",
    "VERIFY FIT-UP AND SQUARE BEFORE FINAL WELD OUT.",
    "WELD SYMBOLS PER AWS A2.4, INSPECT BEFORE COATING."
  ]
  notes.forEach((note, idx) => {
    const ny = notesBody.y + idx * 16
    doc.fillColor(colors.warn).font("Helvetica-Bold").fontSize(7).text(`${idx + 1}.`, notesBody.x + 2, ny + 2)
    doc.fillColor(colors.mute).font("Helvetica").fontSize(7.8).text(note, notesBody.x + 16, ny + 2, { width: notesBody.w - 18 })
  })

  // Professional title block
  const tbW = 430
  const tbH = 72
  const tbX = pageWidth - tbW - 18
  const tbY = pageHeight - tbH - 22
  doc.roundedRect(tbX, tbY, tbW, tbH, 8).fillAndStroke("#0E1C2B", "#2D4963")
  doc.moveTo(tbX + 220, tbY).lineTo(tbX + 220, tbY + tbH).strokeColor("#2D4963").lineWidth(1).stroke()
  doc.moveTo(tbX + 320, tbY).lineTo(tbX + 320, tbY + tbH).strokeColor("#2D4963").lineWidth(1).stroke()
  doc.moveTo(tbX, tbY + 24).lineTo(tbX + tbW, tbY + 24).strokeColor("#2D4963").lineWidth(1).stroke()
  doc.moveTo(tbX + 220, tbY + 48).lineTo(tbX + tbW, tbY + 48).strokeColor("#2D4963").lineWidth(1).stroke()

  const drawingNo = `WB-${sanitizeFilename(project).toUpperCase().slice(0, 18)}-${String(L).padStart(3, "0")}`
  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("DRAWING TITLE", tbX + 10, tbY + 7)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(10).text(project.toUpperCase(), tbX + 10, tbY + 12, { width: 200 })
  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("DRAWING NO.", tbX + 230, tbY + 7)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text(drawingNo, tbX + 230, tbY + 12, { width: 86 })
  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("REV", tbX + 330, tbY + 7)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text("A", tbX + 330, tbY + 12)

  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("SCALE", tbX + 230, tbY + 30)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text("NTS", tbX + 230, tbY + 36)
  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("SHEET", tbX + 330, tbY + 30)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text("1 OF 1", tbX + 330, tbY + 36)

  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("CHECKED BY", tbX + 10, tbY + 54)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text("WELDBLUEPRINTS AI", tbX + 70, tbY + 53)
  doc.fillColor(colors.mute).font("Helvetica").fontSize(7).text("DATE", tbX + 230, tbY + 54)
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text(new Date().toLocaleDateString(), tbX + 260, tbY + 53)

  doc.rect(0, pageHeight - 18, pageWidth, 18).fill(colors.panel)
  doc.fillColor(colors.mute).font("Helvetica").fontSize(8).text(
    `WELDBLUEPRINTS AI  |  ${project.toUpperCase()}  |  ${L}" x ${W}" x ${H}"  |  VERIFY ALL DIMENSIONS BEFORE CUTTING`,
    24,
    pageHeight - 12
  )
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
  const user = users.find(u => u.id === req.user.id)
  if (!user) return res.status(404).json({ error: "User not found" })
  res.json({ user: makeSafeUser(user) })
})

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true })
  })
})

app.post("/api/projects/save", authenticateToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id)
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
  const list = savedProjects.filter(p => p.userId === req.user.id)
  res.json({ projects: list })
})

app.delete("/api/projects/:id", authenticateToken, (req, res) => {
  const projectId = Number(req.params.id)
  const index = savedProjects.findIndex(p => p.id === projectId && p.userId === req.user.id)
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

app.get("/api/settings/:welder", (req, res) => {
  const welder = req.params.welder
  if (!weldSettingsDB[welder]) {
    return res.status(404).json({ error: "Welder not found" })
  }
  res.json(weldSettingsDB[welder])
})

app.get("/api/gallery", (req, res) => {
  res.json(blueprintGallery)
})

app.post("/api/analyze-scrap", (req, res) => {
  const suggestions = analyzeScrap(req.body.scrap)
  res.json({ suggestions })
})

app.get("/api/subscription/status", authenticateToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id)
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

  const user = users.find(u => u.id === req.user.id)
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
    user = users.find(u => u.id === decoded.id)
  } catch (err) {
    trackEvent("generate_error")
    return res.status(403).json({ error: "Invalid token" })
  }

  if (!user) {
    trackEvent("generate_error")
    return res.status(404).json({ error: "User not found" })
  }

  if (!user.isPro) {
    const used = user.generationsUsed || 0
    if (used >= FREE_GENERATION_LIMIT) {
      return res.status(403).json({
        error: "free_limit_reached",
        message: `Free plan limit of ${FREE_GENERATION_LIMIT} blueprints reached.`,
        upgradeUrl: "/pricing.html"
      })
    }

    if (!req.query.preview) {
      user.generationsUsed = used + 1
      saveData()
    }
  }

  const isPreview = req.query.preview === "1"
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
  res.json({
    totalUsers: users.length,
    proUsers: users.filter(u => u.isPro && !u.isAdmin).length,
    freeUsers: users.filter(u => !u.isPro && !u.isAdmin).length,
    totalGenerations: users.reduce((sum, u) => sum + (u.generationsUsed || 0), 0),
    revenue: users.filter(u => u.isPro && !u.isAdmin && u.paypalOrderID !== "ADMIN_GRANTED").length * 19.99,
    totalProjects: savedProjects.length
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

