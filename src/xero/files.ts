import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { config } from "../config.js";
import { getXeroToken } from "./auth.js";

// Xero Files API ("Documents" in the UI since Sep 2026). Needs the `files`
// scope on the custom connection; requested separately so the daily sync's
// token request is unaffected if the scope is ever missing.
const BASE = "https://api.xero.com/files.xro/1.0";
const SCOPE = "files";

export interface XeroFolder { Id: string; Name: string; FileCount?: number; IsInbox?: boolean; Email?: string }
export interface XeroFile { Id: string; Name: string; MimeType: string; Size: number; FolderId: string; CreatedDateUtc?: string }
export type ObjectGroup = "Invoice" | "BankTransaction" | "Contact" | "ManualJournal" | "CreditNote" | "Payment" | "Receipt" | "Account" | "Overpayment" | "Prepayment" | "Item" | "PurchaseOrder" | "Quote";

async function req(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: BodyInit, contentType?: string): Promise<Response> {
  if (!config.XERO_TENANT_ID) throw new Error("XERO_TENANT_ID missing");
  const token = await getXeroToken(SCOPE);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-Tenant-Id": config.XERO_TENANT_ID,
      Accept: "application/json",
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  if (!res.ok) throw new Error(`Xero Files ${method} ${path} ${res.status}: ${await res.text()}`);
  return res;
}

export async function listFolders(): Promise<XeroFolder[]> {
  return (await (await req("GET", "/Folders")).json()) as XeroFolder[];
}

export async function createFolder(name: string): Promise<XeroFolder> {
  return (await (await req("POST", "/Folders", JSON.stringify({ Name: name }), "application/json")).json()) as XeroFolder;
}

export async function ensureFolder(name: string): Promise<XeroFolder> {
  const existing = (await listFolders()).find((f) => f.Name.toLowerCase() === name.toLowerCase());
  return existing ?? (await createFolder(name));
}

export async function listFiles(folderId?: string, page = 1): Promise<XeroFile[]> {
  const q = new URLSearchParams({ pagesize: "100", page: String(page) });
  const res = await req("GET", `${folderId ? `/Folders/${folderId}/Files` : "/Files"}?${q}`);
  const body = (await res.json()) as { Items?: XeroFile[] } | XeroFile[];
  return Array.isArray(body) ? body : body.Items ?? [];
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export async function uploadFile(localPath: string, opts: { folderId?: string; name?: string } = {}): Promise<XeroFile> {
  const data = await readFile(localPath);
  const name = opts.name ?? basename(localPath);
  const mime = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  // Xero reads the multipart part name as the filename, so the part is named after the file.
  form.append(name, new Blob([data], { type: mime }), name);
  const path = opts.folderId ? `/Files/${opts.folderId}` : "/Files";
  return (await (await req("POST", path, form)).json()) as XeroFile;
}

export async function associateFile(fileId: string, objectId: string, objectGroup: ObjectGroup): Promise<unknown> {
  return (await req("POST", `/Files/${fileId}/Associations`, JSON.stringify({ ObjectId: objectId, ObjectGroup: objectGroup }), "application/json")).json();
}

export async function renameFolder(folderId: string, name: string): Promise<XeroFolder> {
  return (await (await req("PUT", `/Folders/${folderId}`, JSON.stringify({ Name: name }), "application/json")).json()) as XeroFolder;
}

export async function deleteFolder(folderId: string): Promise<void> {
  await req("DELETE", `/Folders/${folderId}`);
}

export async function deleteFile(fileId: string): Promise<void> {
  await req("DELETE", `/Files/${fileId}`);
}
