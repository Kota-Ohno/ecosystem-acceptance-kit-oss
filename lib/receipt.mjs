import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function sealReceipt(receipt) {
  if (receipt.integrity !== undefined) throw new Error("Receipt is already sealed");
  return { ...receipt, integrity: { algorithm: "sha256-jcs", receiptSha256: digest(receipt) } };
}

export function verifyReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Receipt must be an object");
  const { integrity, ...body } = value;
  if (integrity?.algorithm !== "sha256-jcs" || !/^[0-9a-f]{64}$/u.test(integrity.receiptSha256 ?? "")) {
    throw new Error("Receipt integrity record is invalid");
  }
  if (digest(body) !== integrity.receiptSha256) throw new Error("Receipt integrity verification failed");
  return { outcome: body.outcome, receiptSha256: integrity.receiptSha256 };
}

export function writeReceipt(path, receipt) {
  const sealed = sealReceipt(receipt);
  writeFileSync(path, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return sealed;
}

export function loadAndVerifyReceipt(path) {
  return verifyReceipt(JSON.parse(readFileSync(path, "utf8")));
}
