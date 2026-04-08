#!/usr/bin/env node

const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { mkdtempSync, rmSync } = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "weldblueprintai-smoke-"))
const port = 4000 + Math.floor(Math.random() * 500)
const baseUrl = `http://127.0.0.1:${port}`

const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  APP_ORIGIN: baseUrl,
  JWT_SECRET: "test-jwt-secret",
  SESSION_SECRET: "test-session-secret",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "TestAdminPassword123!",
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test-client-secret",
  DATA_FILE: path.join(tempRoot, "data.json"),
  ANALYTICS_FILE: path.join(tempRoot, "analytics.json"),
  BACKUP_DIR: path.join(tempRoot, "backups"),
  SESSION_DIR: path.join(tempRoot, "sessions")
}

let serverProcess = null
let serverOutput = ""

function appendOutput(chunk) {
  const text = String(chunk || "")
  if (!text) return
  serverOutput = `${serverOutput}${text}`.slice(-8000)
}

function startServer() {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  })
  serverProcess.stdout.on("data", appendOutput)
  serverProcess.stderr.on("data", appendOutput)
}

async function waitForServerReady(timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`Server exited early with code ${serverProcess.exitCode}\n${serverOutput}`)
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`)
      if (res.ok) return
    } catch (_) {
      // Retry until timeout.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for server readiness.\n${serverOutput}`)
}

async function fetchJson(urlPath, options = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, options)
  const bodyText = await res.text()
  let json = null
  if (bodyText) {
    try {
      json = JSON.parse(bodyText)
    } catch (_) {
      json = null
    }
  }
  return { res, json, bodyText }
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return
  const child = serverProcess
  await new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch (_) {}
      finish()
    }, 8000)
    child.once("exit", () => {
      clearTimeout(timer)
      finish()
    })
    try {
      child.kill("SIGTERM")
    } catch (_) {
      clearTimeout(timer)
      finish()
    }
  })
}

async function runSmokeSuite() {
  startServer()
  await waitForServerReady()

  const healthz = await fetchJson("/healthz")
  assert.equal(healthz.res.status, 200, "GET /healthz should return 200")
  assert.equal(healthz.json && healthz.json.ok, true, "GET /healthz should return { ok: true }")

  const health = await fetchJson("/health")
  assert.equal(health.res.status, 200, "GET /health should return 200")
  assert.equal(health.json && health.json.ok, true, "GET /health should return { ok: true }")

  const indexPage = await fetch(`${baseUrl}/index.html`)
  assert.equal(indexPage.status, 200, "GET /index.html should return 200")
  assert.match(indexPage.headers.get("content-type") || "", /text\/html/i, "index page should be HTML")

  const blockedPaths = [
    "/data.json",
    "/analytics.json",
    "/server.js",
    "/package.json",
    "/backups/example.json",
    "/sessions/example.json"
  ]
  for (const blocked of blockedPaths) {
    const res = await fetch(`${baseUrl}${blocked}`)
    assert.equal(res.status, 404, `Sensitive path should be blocked: ${blocked}`)
  }

  const registerPayload = {
    username: "Smoke Test User",
    email: "smoke@example.com",
    password: "StrongPass123!",
    welderModel: "Lincoln 210 MP",
    experience: "Beginner"
  }
  const register = await fetchJson("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registerPayload)
  })
  assert.equal(register.res.status, 200, "POST /api/auth/register should return 200")
  assert.ok(register.json && register.json.token, "Registration should return a JWT token")

  const token = register.json.token

  const me = await fetchJson("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(me.res.status, 200, "GET /api/auth/me should return 200 with valid token")
  assert.equal(me.json && me.json.user && me.json.user.email, "smoke@example.com")

  const blueprintPayload = {
    project: "Welding Cart",
    dimensions: "36x20x38",
    welder: "Lincoln 210 MP",
    process: "MIG",
    wire: "ER70S-6",
    wiresize: ".030",
    gas: "C25",
    thickness: "1/8",
    notes: "Smoke test blueprint generation"
  }
  const blueprint = await fetch(`${baseUrl}/generate-blueprint?preview=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(blueprintPayload)
  })
  assert.equal(blueprint.status, 200, "POST /generate-blueprint should return 200")
  assert.match(blueprint.headers.get("content-type") || "", /application\/pdf/i, "Blueprint response should be PDF")
  await blueprint.arrayBuffer()

  console.log("Smoke test passed.")
}

;(async () => {
  try {
    await runSmokeSuite()
  } catch (err) {
    console.error("Smoke test failed:", err.message)
    process.exitCode = 1
  } finally {
    await stopServer()
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch (_) {}
  }
})()
