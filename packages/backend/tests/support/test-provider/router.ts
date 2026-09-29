export { testProviderRouter }

import express from "express"

import { Failure } from "@lib/result"
import { isRecord } from "@lib/helpers/object"
import { type FakeProvider, type DeviceOutcome, type GrantOutcome } from "@tests/support/test-provider/adapter"

const DEVICE_LABELS: Record<DeviceOutcome, string> = {
  approve: "approved",
  approve_quota: "approved (usage limit)",
  deny: "denied",
  expire: "expired",
}

const GRANT_ACTIONS: Record<GrantOutcome, string> = {
  revoked: "Revoke",
  expired: "Expire",
  quota: "Exhaust quota",
  ok: "Restore",
}

const isDeviceOutcome = (value: string): value is DeviceOutcome => Object.hasOwn(DEVICE_LABELS, value)
const isGrantOutcome = (value: string): value is GrantOutcome => Object.hasOwn(GRANT_ACTIONS, value)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function stringField(source: unknown, key: string): string {
  if (!isRecord(source)) return ""
  const value = source[key]
  return typeof value === "string" ? value : ""
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}

function deviceForm(notice: string): string {
  return `${notice}<form method="post" action="device">
    <label>User code <input type="text" name="user_code" required></label>
    <label>Account <input type="text" name="account" placeholder="tester@example.test"></label>
    <button type="submit" name="outcome" value="approve">Approve</button>
    <button type="submit" name="outcome" value="approve_quota">Approve (usage limit)</button>
    <button type="submit" name="outcome" value="deny">Deny</button>
    <button type="submit" name="outcome" value="expire">Expire code</button>
  </form>`
}

function grantsTable(fake: FakeProvider): string {
  const rows = fake
    .grants()
    .map((g) => {
      const buttons = Object.entries(GRANT_ACTIONS)
        .map(
          ([value, label]) =>
            `<form method="post" action="grants" style="display:inline">
              <input type="hidden" name="id" value="${escapeHtml(g.id)}">
              <button type="submit" name="outcome" value="${value}">${label}</button>
            </form>`
        )
        .join(" ")
      return `<tr><td>${escapeHtml(g.id)}</td><td>${escapeHtml(g.provider)}</td><td>${escapeHtml(g.method)}</td><td>${escapeHtml(g.account)}</td><td>${escapeHtml(g.status)}</td><td>${buttons}</td></tr>`
    })
    .join("")
  return `<table><thead><tr><th>Id</th><th>Provider</th><th>Method</th><th>Account</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
}

function testProviderRouter(fake: FakeProvider): express.Router {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))

  router.get("/device", (_req, res) => {
    res.type("html").send(layout("Approve a device code", deviceForm("")))
  })

  router.post("/device", (req, res) => {
    const userCode = stringField(req.body, "user_code")
    const account = stringField(req.body, "account")
    const outcome = stringField(req.body, "outcome")
    if (!isDeviceOutcome(outcome)) {
      res
        .status(400)
        .type("html")
        .send(layout("Approve a device code", deviceForm("<p>Choose an action.</p>")))
      return
    }
    const decided = fake.decideDevice(userCode, outcome, account)
    if (decided instanceof Failure) {
      res
        .status(404)
        .type("html")
        .send(layout("Approve a device code", deviceForm(`<p>${escapeHtml(decided.error)}</p>`)))
      return
    }
    const accountNote = account === "" ? "" : ` for ${escapeHtml(account)}`
    res
      .type("html")
      .send(
        layout(
          "Device code decided",
          `<p>Marked ${escapeHtml(DEVICE_LABELS[outcome])}${accountNote}. You can close this tab.</p>`
        )
      )
  })

  router.get("/grants", (_req, res) => {
    res.type("html").send(layout("Issued grants", grantsTable(fake)))
  })

  router.post("/grants", (req, res) => {
    const id = stringField(req.body, "id")
    const outcome = stringField(req.body, "outcome")
    if (isGrantOutcome(outcome)) fake.setGrant(id, outcome)
    res.redirect(303, "grants")
  })

  return router
}
