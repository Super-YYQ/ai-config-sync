import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RiskLevel } from "@ai-config-sync/core";
import {
  BootstrapSession,
  type BootstrapConnectInput,
} from "./bootstrap-session.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
// Fetch-compatible browsers reject these ports even when a server is local.
// See the WHATWG Fetch "bad port" list.
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export interface BootstrapWebOptions {
  session?: BootstrapSession;
  port?: number;
  openBrowser?: boolean;
  idleTimeoutMs?: number;
}

export interface BootstrapWebHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
  closed: Promise<void>;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function text(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function riskLevel(value: unknown): RiskLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openLocalBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // The URL is also printed by the CLI; failure to open a browser is not fatal.
  });
  child.unref();
}

function pageHtml(token: string, nonce: string): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Config Sync · Bootstrap</title>
  <style nonce="__NONCE__">
    :root { color-scheme: dark; --bg:#090d12; --panel:#111820; --line:#263342; --text:#eef5fb; --muted:#94a5b5; --cyan:#5fe0d0; --blue:#6fa8ff; --warn:#ffc56b; --bad:#ff7f8d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font:15px/1.5 Inter,ui-sans-serif,system-ui,"Segoe UI",sans-serif; color:var(--text); background:radial-gradient(circle at 12% 0%,#17304b 0,transparent 38%),radial-gradient(circle at 94% 14%,#123f3a 0,transparent 32%),var(--bg); }
    main { width:min(1080px,calc(100% - 32px)); margin:0 auto; padding:42px 0 70px; }
    header { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; margin-bottom:28px; }
    h1 { margin:0; font-size:clamp(28px,5vw,46px); letter-spacing:-.04em; }
    header p { margin:8px 0 0; color:var(--muted); max-width:680px; }
    .pill { border:1px solid var(--line); background:#0d141b; color:var(--cyan); padding:7px 11px; border-radius:999px; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,.85fr); gap:18px; }
    .card { background:color-mix(in srgb,var(--panel) 92%,transparent); border:1px solid var(--line); border-radius:18px; padding:22px; box-shadow:0 18px 60px #0006; backdrop-filter:blur(14px); }
    .card h2 { font-size:17px; margin:0 0 16px; }
    .status-heading { margin-top:24px !important; }
    label { display:block; color:var(--muted); font-size:13px; margin:14px 0 6px; }
    input,select { width:100%; background:#090f15; border:1px solid #314052; color:var(--text); border-radius:10px; padding:11px 12px; outline:none; }
    input:focus,select:focus { border-color:var(--cyan); box-shadow:0 0 0 3px #5fe0d020; }
    .checks { display:flex; flex-wrap:wrap; gap:10px 18px; margin:16px 0; }
    .checks label { margin:0; display:flex; align-items:center; gap:7px; color:var(--text); }
    .checks input { width:auto; }
    button { border:0; border-radius:10px; padding:11px 15px; font-weight:700; cursor:pointer; background:linear-gradient(135deg,var(--cyan),var(--blue)); color:#06121a; }
    button.secondary { background:#1a2530; color:var(--text); border:1px solid var(--line); }
    button.danger { background:#321b23; color:#ffbac2; border:1px solid #6f3441; }
    button:disabled { opacity:.42; cursor:not-allowed; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .status { min-height:58px; padding:12px 14px; background:#0a1118; border:1px solid var(--line); border-radius:12px; color:var(--muted); white-space:pre-wrap; }
    .status.ok { color:#9ef0c5; border-color:#275e49; }
    .status.error { color:#ffb1ba; border-color:#71333d; }
    .summary { display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin:0 0 14px; }
    .metric { background:#0a1118; border:1px solid var(--line); border-radius:11px; padding:11px; }
    .metric strong { display:block; font-size:21px; }
    .metric span { color:var(--muted); font-size:12px; }
    .plan { max-height:460px; overflow:auto; display:grid; gap:8px; }
    .plan-item { border:1px solid var(--line); background:#0b1219; border-radius:11px; padding:11px 12px; }
    .plan-item .meta { color:var(--muted); font-size:12px; margin-top:3px; }
    .risk-low { color:#8de7be; } .risk-medium { color:var(--warn); } .risk-high { color:var(--bad); }
    details { margin-top:14px; }
    pre { overflow:auto; max-height:310px; background:#080d12; border:1px solid var(--line); border-radius:10px; padding:12px; color:#b9c8d4; font-size:12px; }
    footer { margin-top:18px; color:var(--muted); display:flex; justify-content:space-between; gap:12px; }
    @media (max-width:820px) { .grid{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}header{display:block}.pill{display:inline-block;margin-top:14px} }
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>恢复你的 AI 工作环境</h1><p>连接私有配置仓库，检查恢复计划，并用一次明确确认安装 Skill、Plugin、Hook 与受管配置。</p></div>
    <span class="pill" id="connectionPill">正在检查连接…</span>
  </header>
  <div class="grid">
    <section class="card">
      <h2>1 · 连接配置仓库</h2>
      <label for="repo">私有 Git 仓库地址</label>
      <input id="repo" placeholder="git@github.com:you/my-ai-config.git">
      <label for="configPath">本机目录（可选）</label>
      <input id="configPath" placeholder="默认：~/ai-config/my-ai-config">
      <label for="profile">Profile</label>
      <input id="profile" value="home">
      <div class="checks">
        <label><input id="claude" type="checkbox" checked> Claude</label>
        <label><input id="codex" type="checkbox" checked> Codex</label>
        <label><input id="codexHook" type="checkbox"> 启用 Codex SessionStart Hook</label>
      </div>
      <div class="actions">
        <button id="connect">连接并检查</button>
        <button id="doctor" class="secondary">运行 Doctor</button>
      </div>
      <h2 class="status-heading">状态</h2>
      <div id="status" class="status">等待操作。</div>
      <details><summary>诊断详情</summary><pre id="details">尚无</pre></details>
    </section>
    <section class="card">
      <h2>2 · 查看并执行 Plan</h2>
      <div class="summary">
        <div class="metric"><strong id="total">0</strong><span>总操作</span></div>
        <div class="metric"><strong id="low">0</strong><span>Low</span></div>
        <div class="metric"><strong id="medium">0</strong><span>Medium</span></div>
        <div class="metric"><strong id="high">0</strong><span>High</span></div>
      </div>
      <div id="plan" class="plan"><div class="status">连接仓库后生成恢复计划。</div></div>
      <label for="allowRisk">允许的最高风险</label>
      <select id="allowRisk"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
      <div class="actions">
        <button id="buildPlan" class="secondary" disabled>重新生成 Plan</button>
        <button id="apply" disabled>确认并开始恢复</button>
      </div>
    </section>
  </div>
  <footer><span>页面仅通过 127.0.0.1 访问；Plan 与 Apply 使用同一份快照。</span><button id="shutdown" class="danger">关闭本地服务</button></footer>
</main>
<script nonce="__NONCE__">
  const TOKEN = "__TOKEN__";
  const $ = (id) => document.getElementById(id);
  let linked = false;
  let hasPlan = false;

  async function request(path, options) {
    const init = Object.assign({ method: "GET", headers: {} }, options || {});
    init.headers["X-AI-Config-Sync-Token"] = TOKEN;
    if (init.body && typeof init.body !== "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
  }

  function busy(value, message) {
    ["connect","doctor","buildPlan","apply"].forEach((id) => $(id).disabled = value || (id === "apply" && !hasPlan) || (id === "buildPlan" && !linked));
    if (message) setStatus(message);
  }

  function setStatus(message, kind) {
    $("status").textContent = message;
    $("status").className = "status" + (kind ? " " + kind : "");
  }

  function renderPlan(plan) {
    hasPlan = true;
    const counts = { low:0, medium:0, high:0 };
    plan.actions.forEach((action) => counts[action.risk]++);
    $("total").textContent = String(plan.actions.length);
    $("low").textContent = String(counts.low);
    $("medium").textContent = String(counts.medium);
    $("high").textContent = String(counts.high);
    $("plan").replaceChildren(...plan.actions.map((action) => {
      const item = document.createElement("div"); item.className = "plan-item";
      const title = document.createElement("div"); title.textContent = action.type + " · " + action.description;
      const meta = document.createElement("div"); meta.className = "meta";
      const risk = document.createElement("span"); risk.className = "risk-" + action.risk; risk.textContent = action.risk.toUpperCase();
      meta.append(risk, document.createTextNode(" · " + (action.target || "global") + (action.resourceId ? " · " + action.resourceId : "")));
      item.append(title, meta); return item;
    }));
    if (plan.actions.length === 0) $("plan").innerHTML = '<div class="status ok">无需恢复，当前环境已符合配置。</div>';
    $("apply").disabled = plan.actions.length === 0;
    $("details").textContent = JSON.stringify(plan, null, 2);
  }

  async function refreshStatus() {
    try {
      const payload = await request("/api/status");
      linked = payload.connection.linked;
      $("connectionPill").textContent = linked ? "已连接 · " + payload.connection.configRepoPath : "尚未连接";
      $("buildPlan").disabled = !linked;
      if (payload.connection.localConfig) $("profile").value = payload.connection.localConfig.profile || "home";
    } catch (error) { setStatus(error.message, "error"); }
  }

  $("connect").onclick = async () => {
    busy(true, "正在连接并检查配置仓库…");
    try {
      const payload = await request("/api/connect", { method:"POST", body:{ repo:$("repo").value, configPath:$("configPath").value, profile:$("profile").value, claude:$("claude").checked, codex:$("codex").checked, enableCodexHook:$("codexHook").checked } });
      $("details").textContent = JSON.stringify(payload.setup, null, 2);
      linked = payload.connection.linked;
      setStatus("配置仓库已连接。正在生成恢复 Plan…", "ok");
      await refreshStatus();
      const planned = await request("/api/plan", { method:"POST", body:{ profile:$("profile").value } });
      renderPlan(planned.plan); setStatus("Plan 已生成，请检查后确认恢复。", "ok");
    } catch (error) { setStatus(error.message, "error"); }
    finally { busy(false); }
  };

  $("buildPlan").onclick = async () => {
    busy(true, "正在刷新并构建 Plan…");
    try { const payload = await request("/api/plan", { method:"POST", body:{ profile:$("profile").value } }); renderPlan(payload.plan); setStatus("Plan 已更新。", "ok"); }
    catch (error) { setStatus(error.message, "error"); }
    finally { busy(false); }
  };

  $("apply").onclick = async () => {
    if (!confirm("将按刚刚显示的 Plan 修改本机配置。是否继续？")) return;
    busy(true, "正在恢复，请不要关闭页面…");
    try {
      const payload = await request("/api/apply", { method:"POST", body:{ confirm:true, allowRisk:$("allowRisk").value } });
      $("details").textContent = JSON.stringify(payload, null, 2);
      hasPlan = false; $("apply").disabled = true;
      setStatus(payload.result.failed.length ? "恢复完成，但有失败项，请查看详情。" : "恢复完成，Doctor 正在验证…", payload.result.failed.length ? "error" : "ok");
      const checked = await request("/api/doctor", { method:"POST", body:{} });
      $("details").textContent = JSON.stringify(checked.report, null, 2);
      setStatus(checked.report.ok ? "恢复完成，Doctor PASS。" : "恢复完成，Doctor 发现需要处理的问题。", checked.report.ok ? "ok" : "error");
    } catch (error) { setStatus(error.message, "error"); }
    finally { busy(false); }
  };

  $("doctor").onclick = async () => {
    busy(true, "正在运行 Doctor…");
    try { const payload = await request("/api/doctor", { method:"POST", body:{} }); $("details").textContent = JSON.stringify(payload.report, null, 2); setStatus(payload.report.ok ? "Doctor PASS。" : "Doctor 发现问题，请查看详情。", payload.report.ok ? "ok" : "error"); }
    catch (error) { setStatus(error.message, "error"); }
    finally { busy(false); }
  };

  $("shutdown").onclick = async () => { try { await request("/api/shutdown", { method:"POST", body:{} }); document.body.innerHTML = '<main><div class="card"><h1>本地服务已关闭</h1><p>现在可以关闭此页面。</p></div></main>'; } catch {} };
  setInterval(() => request("/api/heartbeat", { method:"POST", body:{} }).catch(() => {}), 30000);
  refreshStatus();
</script>
</body>
</html>`
    .replaceAll("__NONCE__", nonce)
    .replace("__TOKEN__", token);
}

export async function startBootstrapWeb(
  options: BootstrapWebOptions = {},
): Promise<BootstrapWebHandle> {
  const requestedPort = options.port ?? 0;
  if (requestedPort !== 0 && BROWSER_BLOCKED_PORTS.has(requestedPort)) {
    throw new Error(`Port ${requestedPort} is blocked by Web browsers`);
  }
  const session = options.session ?? new BootstrapSession();
  const token = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(18).toString("base64url");
  const idleTimeoutMs = Math.max(options.idleTimeoutMs ?? 15 * 60_000, 10_000);
  let lastActivity = Date.now();
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const server = http.createServer(async (request, response) => {
    lastActivity = Date.now();
    const address = server.address() as AddressInfo | null;
    const allowedHosts = new Set([
      `${LOOPBACK_HOST}:${address?.port ?? options.port ?? 0}`,
      `localhost:${address?.port ?? options.port ?? 0}`,
    ]);
    if (!request.headers.host || !allowedHosts.has(request.headers.host.toLowerCase())) {
      return text(response, 403, "Forbidden host");
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/") {
      const html = pageHtml(token, nonce);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      });
      return response.end(html);
    }

    if (!url.pathname.startsWith("/api/")) return text(response, 404, "Not found");
    const requestToken = request.headers["x-ai-config-sync-token"];
    if (requestToken !== token) return json(response, 403, { error: "Invalid session token" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) {
      return json(response, 403, { error: "Invalid origin" });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(response, 200, {
          connection: await session.connection(),
          hasReviewedPlan: Boolean(session.latestPlan()),
        });
      }
      if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
      const body = await readJsonBody(request);
      if (url.pathname === "/api/heartbeat") return json(response, 200, { ok: true });
      if (url.pathname === "/api/connect") {
        const input: BootstrapConnectInput = {
          repo: optionalString(body.repo),
          configPath: optionalString(body.configPath),
          profile: optionalString(body.profile),
          claude: optionalBoolean(body.claude),
          codex: optionalBoolean(body.codex),
          enableCodexHook: optionalBoolean(body.enableCodexHook),
          reconfigure: optionalBoolean(body.reconfigure),
        };
        if (!input.repo && !input.configPath && !(await session.connection()).linked) {
          throw new Error("请输入私有仓库地址或本机配置仓库目录");
        }
        const setup = await session.connect(input);
        return json(response, 200, {
          setup,
          connection: await session.connection(),
        });
      }
      if (url.pathname === "/api/plan") {
        const plan = await session.plan({
          profile: optionalString(body.profile),
          offline: optionalBoolean(body.offline),
        });
        return json(response, 200, { plan });
      }
      if (url.pathname === "/api/apply") {
        if (body.confirm !== true) throw new Error("Apply requires explicit confirmation");
        const result = await session.apply({
          allowRisk: riskLevel(body.allowRisk),
          offline: optionalBoolean(body.offline),
        });
        return json(response, 200, { result });
      }
      if (url.pathname === "/api/doctor") {
        return json(response, 200, { report: await session.doctor() });
      }
      if (url.pathname === "/api/shutdown") {
        json(response, 200, { ok: true });
        setTimeout(() => void close(), 50);
        return;
      }
      return json(response, 404, { error: "Unknown endpoint" });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  });

  const close = async (): Promise<void> => {
    if (closing) return closed;
    closing = true;
    clearInterval(idleTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    resolveClosed();
  };

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= idleTimeoutMs) void close();
  }, Math.min(30_000, Math.max(2_000, Math.floor(idleTimeoutMs / 4))));
  idleTimer.unref();

  const listen = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  };
  await listen();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const selected = (server.address() as AddressInfo).port;
    if (!BROWSER_BLOCKED_PORTS.has(selected)) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen();
  }
  const address = server.address() as AddressInfo;
  if (BROWSER_BLOCKED_PORTS.has(address.port)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearInterval(idleTimer);
    throw new Error("Could not allocate a browser-safe local port");
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}/`;
  if (options.openBrowser !== false) openLocalBrowser(url);

  return { url, port: address.port, token, close, closed };
}
