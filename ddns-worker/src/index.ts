export interface Env {
  CF_API_TOKEN: string;
  ZONE_ID: string;
  RECORD_NAME: string;
  ADMIN_PASSWORD: string;
}

interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  modified_on: string;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { total_count: number };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");

    if (path === "/nic/update" || path === "/update") return handleUpdate(request, env);

    if (path === "/nic/checkip" || path === "/checkip") {
      return new Response(request.headers.get("cf-connecting-ip") || "unknown");
    }

    if (path === "/admin" || path === "/admin/") {
      return requireAdmin(request, env) ? dashboard() : unauthorized();
    }

    if (path === "/api/records" && request.method === "GET") {
      if (!requireAdmin(request, env)) return unauthorized();
      return listRecords(env);
    }

    if (path === "/api/records" && request.method === "POST") {
      if (!requireAdmin(request, env)) return unauthorized();
      return createRecord(request, env);
    }

    if (path.startsWith("/api/records/") && request.method === "DELETE") {
      if (!requireAdmin(request, env)) return unauthorized();
      const id = path.split("/api/records/")[1];
      return deleteRecord(id, env);
    }

    if (path.startsWith("/api/records/") && request.method === "PUT") {
      if (!requireAdmin(request, env)) return unauthorized();
      const id = path.split("/api/records/")[1];
      return updateRecord(id, request, env);
    }

    return new Response("Synology DDNS Worker\n\nEndpoints:\n  /admin              - Management dashboard\n  /update             - DDNS update\n  /nic/update         - Synology-compatible update\n  /checkip            - Public IP\n  /health             - Health check\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

function requireAdmin(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) return false;
  const [, pass] = atob(authHeader.slice(6)).split(":");
  return pass === env.ADMIN_PASSWORD;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin"', "Content-Type": "text/plain" },
  });
}

async function cfFetch(path: string, env: Env, method = "GET", body?: object): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function listRecords(env: Env): Promise<Response> {
  const resp = await cfFetch(`/zones/${env.ZONE_ID}/dns_records?type=A`, env);
  const data: CloudflareResponse<DNSRecord[]> = await resp.json();
  return jsonResponse(data);
}

async function createRecord(request: Request, env: Env): Promise<Response> {
  const { name, content } = await request.json<{ name: string; content: string }>();
  const resp = await cfFetch(`/zones/${env.ZONE_ID}/dns_records`, env, "POST", {
    type: "A", name, content, ttl: 1, proxied: false,
  });
  const data: CloudflareResponse<DNSRecord> = await resp.json();
  return jsonResponse(data, data.success ? 201 : 400);
}

async function deleteRecord(id: string, env: Env): Promise<Response> {
  const resp = await cfFetch(`/zones/${env.ZONE_ID}/dns_records/${id}`, env, "DELETE");
  const data = await resp.json();
  return jsonResponse(data);
}

async function updateRecord(id: string, request: Request, env: Env): Promise<Response> {
  const { name, content } = await request.json<{ name: string; content: string }>();
  const resp = await cfFetch(`/zones/${env.ZONE_ID}/dns_records/${id}`, env, "PUT", {
    type: "A", name, content, ttl: 1, proxied: false,
  });
  const data: CloudflareResponse<DNSRecord> = await resp.json();
  return jsonResponse(data);
}

async function handleUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get("hostname") || url.searchParams.get("host");
  const myip = url.searchParams.get("myip") || url.searchParams.get("ip");

  if (!hostname || !myip) return plainText("badauth", 401);

  const authHeader = request.headers.get("Authorization");
  const basicAuth = authHeader?.startsWith("Basic ") ? atob(authHeader.slice(6)) : null;

  if (basicAuth) {
    const [, pass] = basicAuth.split(":");
    if (pass !== env.CF_API_TOKEN) return plainText("badauth", 401);
  }

  try {
    const cfApiBase = `/zones/${env.ZONE_ID}/dns_records`;
    const listResp = await cfFetch(`${cfApiBase}?type=A&name=${encodeURIComponent(hostname)}`, env);
    const listData: CloudflareResponse<DNSRecord[]> = await listResp.json();

    if (!listData.success) return plainText("badauth", 500);

    const existing = listData.result.find((r) => r.type === "A" && r.name === hostname);

    if (existing) {
      if (existing.content === myip) return plainText("good " + myip);
      const updateResp = await cfFetch(`${cfApiBase}/${existing.id}`, env, "PUT", {
        type: "A", name: hostname, content: myip, ttl: 1, proxied: false,
      });
      const updateData: CloudflareResponse<DNSRecord> = await updateResp.json();
      if (!updateData.success) return plainText("fail updating", 500);
      return plainText("good " + myip);
    }

    const createResp = await cfFetch(cfApiBase, env, "POST", {
      type: "A", name: hostname, content: myip, ttl: 1, proxied: false,
    });
    const createData: CloudflareResponse<DNSRecord> = await createResp.json();
    if (!createData.success) return plainText("fail creating", 500);
    return plainText("good " + myip);
  } catch (err) {
    return plainText("fail " + (err instanceof Error ? err.message : "unknown"), 500);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function plainText(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function dashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Synology DDNS Manager</title>
<style>
  :root { --bg: #0a0a0a; --card: #111; --border: #222; --accent: #f6821f; --text: #e0e0e0; --muted: #888; --danger: #e53e3e; --success: #38a169; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
  h1 { font-size: 1.5rem; font-weight: 600; }
  h1 span { color: var(--accent); }
  .badge { background: var(--accent); color: #000; font-size: 0.7rem; padding: 2px 8px; border-radius: 9999px; font-weight: 700; text-transform: uppercase; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; margin-bottom: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; font-weight: 500; }
  td { font-size: 0.9rem; }
  .ip { font-family: 'SF Mono', Monaco, monospace; color: var(--accent); }
  .name { font-weight: 500; }
  .time { color: var(--muted); font-size: 0.8rem; }
  .actions { display: flex; gap: 0.5rem; }
  button { cursor: pointer; border: none; border-radius: 6px; padding: 0.4rem 0.8rem; font-size: 0.8rem; font-weight: 500; transition: opacity 0.15s; }
  button:hover { opacity: 0.85; }
  .btn-edit { background: #2563eb; color: #fff; }
  .btn-delete { background: var(--danger); color: #fff; }
  .btn-primary { background: var(--accent); color: #000; font-weight: 600; }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
  .form-row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
  .form-group { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 150px; }
  .form-group label { font-size: 0.8rem; color: var(--muted); }
  input { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; color: var(--text); font-size: 0.9rem; outline: none; transition: border-color 0.15s; }
  input:focus { border-color: var(--accent); }
  .empty { text-align: center; padding: 2rem; color: var(--muted); }
  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.75rem 1.25rem; border-radius: 8px; color: #fff; font-size: 0.85rem; font-weight: 500; z-index: 100; animation: slideIn 0.3s ease; }
  .toast.success { background: var(--success); }
  .toast.error { background: var(--danger); }
  @keyframes slideIn { from { transform: translateY(1rem); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .endpoint { font-family: 'SF Mono', Monaco, monospace; background: var(--bg); padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.85rem; display: block; margin-top: 0.5rem; color: var(--accent); word-break: break-all; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 600px) { .info-grid { grid-template-columns: 1fr; } .form-row { flex-direction: column; } }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 50; align-items: center; justify-content: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; width: 90%; max-width: 400px; }
  .modal h3 { margin-bottom: 1rem; }
  .modal .form-row { margin-bottom: 1rem; }
  .modal .actions { justify-content: flex-end; margin-top: 1rem; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>Synology</span> DDNS Manager</h1>
    <span class="badge">Cloudflare Workers</span>
  </header>

  <div class="card">
    <h2>Quick Setup</h2>
    <div class="info-grid">
      <div>
        <label style="font-size:0.8rem;color:var(--muted)">Synology DDNS Endpoint</label>
        <code class="endpoint" id="ddns-endpoint">Loading...</code>
      </div>
      <div>
        <label style="font-size:0.8rem;color:var(--muted)">Health Check</label>
        <code class="endpoint" id="health-endpoint">Loading...</code>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Add DNS Record</h2>
    <div class="form-row">
      <div class="form-group">
        <label>Hostname</label>
        <input id="new-name" placeholder="nas.example.com" />
      </div>
      <div class="form-group">
        <label>IP Address</label>
        <input id="new-ip" placeholder="1.2.3.4" />
      </div>
      <button class="btn-primary" onclick="createRecord()" style="height:36px">Add</button>
    </div>
  </div>

  <div class="card">
    <h2>DNS A Records</h2>
    <div id="records-loading" class="empty">Loading records...</div>
    <table id="records-table" style="display:none">
      <thead><tr><th>Hostname</th><th>IP Address</th><th>Last Updated</th><th>Actions</th></tr></thead>
      <tbody id="records-body"></tbody>
    </table>
    <div id="records-empty" class="empty" style="display:none">No A records found</div>
  </div>
</div>

<div id="edit-modal" class="modal-overlay">
  <div class="modal">
    <h3>Edit Record</h3>
    <input type="hidden" id="edit-id" />
    <div class="form-row">
      <div class="form-group">
        <label>Hostname</label>
        <input id="edit-name" />
      </div>
      <div class="form-group">
        <label>IP Address</label>
        <input id="edit-ip" />
      </div>
    </div>
    <div class="actions">
      <button onclick="closeModal()" style="background:var(--border);color:var(--text)">Cancel</button>
      <button class="btn-primary" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<script>
const BASE = location.origin;
document.getElementById('ddns-endpoint').textContent = BASE + '/nic/update?hostname=<your-hostname>&myip=<your-ip>';
document.getElementById('health-endpoint').textContent = BASE + '/health';

async function api(path, opts = {}) {
  const resp = await fetch(BASE + path, { ...opts, headers: { ...opts.headers, 'Content-Type': 'application/json' } });
  return resp.json();
}

async function loadRecords() {
  try {
    const data = await api('/api/records');
    const tbody = document.getElementById('records-body');
    document.getElementById('records-loading').style.display = 'none';
    if (!data.success || !data.result.length) {
      document.getElementById('records-empty').style.display = 'block';
      return;
    }
    document.getElementById('records-table').style.display = 'table';
    tbody.innerHTML = data.result.map(r =>
      '<tr>' +
      '<td class="name">' + r.name + '</td>' +
      '<td class="ip">' + r.content + '</td>' +
      '<td class="time">' + new Date(r.modified_on).toLocaleString() + '</td>' +
      '<td class="actions">' +
      '<button class="btn-edit btn-sm" onclick="openEdit(\\'' + r.id + '\\',\\'' + r.name + '\\',\\'' + r.content + '\\')">Edit</button>' +
      '<button class="btn-delete btn-sm" onclick="deleteRecord(\\'' + r.id + '\\',\\'' + r.name + '\\')">Delete</button>' +
      '</td></tr>'
    ).join('');
  } catch (e) {
    document.getElementById('records-loading').textContent = 'Failed to load records';
  }
}

async function createRecord() {
  const name = document.getElementById('new-name').value.trim();
  const content = document.getElementById('new-ip').value.trim();
  if (!name || !content) return toast('Fill in all fields', 'error');
  const data = await api('/api/records', { method: 'POST', body: JSON.stringify({ name, content }) });
  if (data.success) { toast('Record created'); document.getElementById('new-name').value = ''; document.getElementById('new-ip').value = ''; loadRecords(); }
  else toast(data.errors?.[0]?.message || 'Failed', 'error');
}

async function deleteRecord(id, name) {
  if (!confirm('Delete ' + name + '?')) return;
  const data = await api('/api/records/' + id, { method: 'DELETE' });
  if (data.success) { toast('Record deleted'); loadRecords(); }
  else toast('Failed to delete', 'error');
}

function openEdit(id, name, ip) {
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = name;
  document.getElementById('edit-ip').value = ip;
  document.getElementById('edit-modal').classList.add('active');
}

function closeModal() { document.getElementById('edit-modal').classList.remove('active'); }

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const name = document.getElementById('edit-name').value.trim();
  const content = document.getElementById('edit-ip').value.trim();
  const data = await api('/api/records/' + id, { method: 'PUT', body: JSON.stringify({ name, content }) });
  if (data.success) { toast('Record updated'); closeModal(); loadRecords(); }
  else toast('Failed to update', 'error');
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

loadRecords();
</script>
</body>
</html>`;
