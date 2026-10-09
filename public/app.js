const $ = (id) => document.getElementById(id);
let authMode = "login";
let projectMode = "upload";
let allProjects = [];

$("year").textContent = new Date().getFullYear();

function showMessage(id, message = "", success = false) {
  const el = $(id);
  el.textContent = message;
  el.style.color = success ? "var(--good)" : "var(--warn)";
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("nameField").classList.toggle("hidden", mode !== "register");
  $("authSubmit").innerHTML = mode === "login" ? 'Sign in <span>→</span>' : 'Create account <span>→</span>';
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("password").minLength = mode === "login" ? 1 : 10;
  showMessage("authMessage");
}
function setProjectMode(mode) {
  projectMode = mode;
  $("uploadTab").classList.toggle("active", mode === "upload");
  $("gitTab").classList.toggle("active", mode === "git");
  $("uploadForm").classList.toggle("hidden", mode !== "upload");
  $("gitForm").classList.toggle("hidden", mode !== "git");
}
function showDashboard(user) {
  $("authView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  $("userName").textContent = user.name.split(" ")[0];
  loadProjects();
}
function showAuth() {
  $("authView").classList.remove("hidden");
  $("dashboardView").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
}
async function loadProjects() {
  try {
    const data = await api("/api/projects");
    allProjects = data.projects;
    renderProjects();
  } catch (err) { console.error(err); }
}
function renderProjects() {
  const q = $("projectSearch").value.trim().toLowerCase();
  const projects = allProjects.filter(p => p.name.toLowerCase().includes(q) || (p.source_url || "").toLowerCase().includes(q));
  $("projectCount").textContent = allProjects.length;
  $("gitCount").textContent = allProjects.filter(p => p.source_type === "git").length;
  $("uploadCount").textContent = allProjects.filter(p => p.source_type === "upload").length;
  $("emptyState").classList.toggle("hidden", allProjects.length > 0);
  $("projectsList").classList.toggle("hidden", projects.length === 0);
  if (allProjects.length && projects.length === 0) {
    $("projectsList").innerHTML = '<div class="empty-state"><h3>No matching projects</h3><p>Try a different search term.</p></div>';
    $("projectsList").classList.remove("hidden");
    return;
  }
  $("projectsList").innerHTML = projects.map(p => `
    <article class="project-card">
      <div class="project-top">
        <div class="project-symbol">${p.source_type === "git" ? "⌘" : "⇧"}</div>
        <span class="status">${escapeHtml(p.status)}</span>
      </div>
      <h3>${escapeHtml(p.name)}</h3>
      <div class="project-meta">${p.source_type === "git" ? `Git repository · ${escapeHtml(p.source_url || "")}` : `ZIP upload · ${escapeHtml(p.original_filename || "Website archive")}`}</div>
      <div class="project-bottom"><small>Added ${escapeHtml(new Date(p.created_at + (p.created_at.endsWith("Z") ? "" : "Z")).toLocaleDateString())}</small><button class="delete-btn" data-delete="${escapeHtml(p.id)}">Delete project</button></div>
    </article>`).join("");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function openPanel() {
  $("newProjectPanel").classList.remove("hidden");
  $("newProjectPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  showMessage("authMessage");
  const payload = {
    name: $("name").value.trim(),
    email: $("email").value.trim(),
    password: $("password").value
  };
  try {
    const data = await api(`/api/auth/${authMode === "login" ? "login" : "register"}`, { method: "POST", body: JSON.stringify(payload) });
    $("authForm").reset();
    showDashboard(data.user);
  } catch (err) { showMessage("authMessage", err.message); }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); showAuth(); }
  catch (err) { alert(err.message); }
});
$("newProjectBtn").addEventListener("click", openPanel);
$("emptyCreateBtn").addEventListener("click", openPanel);
$("closePanelBtn").addEventListener("click", () => $("newProjectPanel").classList.add("hidden"));
$("uploadTab").addEventListener("click", () => setProjectMode("upload"));
$("gitTab").addEventListener("click", () => setProjectMode("git"));
$("projectSearch").addEventListener("input", renderProjects);

$("uploadForm").addEventListener("submit", async e => {
  e.preventDefault();
  showMessage("uploadMessage");
  const form = new FormData();
  form.append("name", $("uploadName").value.trim());
  if (!$("siteZip").files[0]) return showMessage("uploadMessage", "Choose a ZIP file first.");
  form.append("siteZip", $("siteZip").files[0]);
  const button = $("uploadForm").querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = "Saving...";
  try {
    const data = await api("/api/projects/upload", { method: "POST", body: form });
    showMessage("uploadMessage", data.message, true);
    $("uploadForm").reset();
    await loadProjects();
  } catch (err) { showMessage("uploadMessage", err.message); }
  finally { button.disabled = false; button.innerHTML = 'Save upload <span>→</span>'; }
});
$("gitForm").addEventListener("submit", async e => {
  e.preventDefault();
  showMessage("gitMessage");
  const button = $("gitForm").querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = "Saving...";
  try {
    const data = await api("/api/projects/git", {
      method: "POST",
      body: JSON.stringify({ name: $("gitName").value.trim(), sourceUrl: $("sourceUrl").value.trim() })
    });
    showMessage("gitMessage", data.message, true);
    $("gitForm").reset();
    await loadProjects();
  } catch (err) { showMessage("gitMessage", err.message); }
  finally { button.disabled = false; button.innerHTML = 'Save repository <span>→</span>'; }
});
$("projectsList").addEventListener("click", async e => {
  const button = e.target.closest("[data-delete]");
  if (!button) return;
  if (!confirm("Delete this project from your dashboard? Uploaded archive files are not automatically removed in this starter.")) return;
  try {
    await api(`/api/projects/${encodeURIComponent(button.dataset.delete)}`, { method: "DELETE" });
    await loadProjects();
  } catch (err) { alert(err.message); }
});

(async function init() {
  try {
    const data = await api("/api/me");
    if (data.user) showDashboard(data.user);
  } catch (err) { console.error(err); }
})();
