(() => {
  const PAGE_SIZE = 40;

  const state = {
    users: [],
    scopes: "",
    consoleUrl: "https://api-console.zoho.in/",
    filter: "all",
    search: "",
    selectedEmail: null,
    inbox: null,
    messages: [],
    nextStart: 1,
    hasMore: false,
    loadingMore: false,
    totalMatched: 0,
  };

  const el = {
    stats: document.getElementById("stats"),
    userList: document.getElementById("userList"),
    search: document.getElementById("search"),
    emptyState: document.getElementById("emptyState"),
    detail: document.getElementById("detail"),
    userStatus: document.getElementById("userStatus"),
    userEmail: document.getElementById("userEmail"),
    userMeta: document.getElementById("userMeta"),
    connectBlock: document.getElementById("connectBlock"),
    readBlock: document.getElementById("readBlock"),
    scopesBox: document.getElementById("scopesBox"),
    consoleLink: document.getElementById("consoleLink"),
    codeInput: document.getElementById("codeInput"),
    connectBtn: document.getElementById("connectBtn"),
    connectHint: document.getElementById("connectHint"),
    oauthConnectBtn: document.getElementById("oauthConnectBtn"),
    oauthEmailHint: document.getElementById("oauthEmailHint"),
    readMailsBtn: document.getElementById("readMailsBtn"),
    loadMoreBtn: document.getElementById("loadMoreBtn"),
    inboxMeta: document.getElementById("inboxMeta"),
    mailLayout: document.getElementById("mailLayout"),
    messageList: document.getElementById("messageList"),
    messageBody: document.getElementById("messageBody"),
    refreshUsers: document.getElementById("refreshUsers"),
    toast: document.getElementById("toast"),
  };

  function showToast(message, kind = "ok") {
    el.toast.hidden = false;
    el.toast.className = `toast ${kind}`;
    el.toast.textContent = message;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data.hint ||
        data.error ||
        data.message ||
        (typeof data === "string" ? data : `Request failed (${res.status})`);
      throw new Error(msg);
    }
    return data;
  }

  function selectedUser() {
    return state.users.find((u) => u.email === state.selectedEmail) || null;
  }

  function filteredUsers() {
    const q = state.search.trim().toLowerCase();
    return state.users.filter((u) => {
      if (state.filter === "connected" && !u.connected) return false;
      if (state.filter === "pending" && u.connected) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        (u.displayName || "").toLowerCase().includes(q)
      );
    });
  }

  function renderUsers() {
    const users = filteredUsers();
    el.userList.innerHTML = "";
    if (!users.length) {
      el.userList.innerHTML =
        '<p class="muted" style="padding:0.75rem">No users match.</p>';
      return;
    }

    for (const user of users) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "user-item" + (user.email === state.selectedEmail ? " active" : "");
      btn.setAttribute("role", "option");
      btn.innerHTML = `
        <div class="email">${escapeHtml(user.email)}</div>
        <div class="row">
          <span>${escapeHtml(user.displayName || user.accountId || "—")}</span>
          <span class="badge ${user.connected ? "ok" : "pending"}">
            ${user.connected ? "Connected" : "Pending"}
          </span>
        </div>`;
      btn.addEventListener("click", () => selectUser(user.email));
      el.userList.appendChild(btn);
    }
  }

  function renderDetail() {
    const user = selectedUser();
    if (!user) {
      el.emptyState.classList.remove("hidden");
      el.detail.classList.add("hidden");
      return;
    }

    el.emptyState.classList.add("hidden");
    el.detail.classList.remove("hidden");
    el.userEmail.textContent = user.email;
    el.userStatus.textContent = user.connected
      ? "Connected mailbox"
      : "Not connected";
    el.userMeta.textContent = [
      user.accountId ? `accountId ${user.accountId}` : null,
      user.zuid ? `zuid ${user.zuid}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    el.scopesBox.textContent = state.scopes || "(scopes not loaded)";
    if (el.consoleLink) el.consoleLink.href = state.consoleUrl;
    if (el.oauthConnectBtn) {
      el.oauthConnectBtn.href = `/api/zoho/mailboxes/authorize?email=${encodeURIComponent(
        user.email
      )}`;
    }
    if (el.oauthEmailHint) el.oauthEmailHint.textContent = user.email;

    if (user.connected) {
      el.connectBlock.classList.add("hidden");
      el.readBlock.classList.remove("hidden");
      el.connectHint.textContent = "";
    } else {
      el.connectBlock.classList.remove("hidden");
      el.readBlock.classList.add("hidden");
      el.mailLayout.classList.add("hidden");
      el.connectHint.textContent =
        "Other users: use Connect via Zoho login. Self Client codes from another Zoho account will return invalid_code.";
    }
  }

  async function loadUsers(force = false) {
    el.stats.textContent = "Loading users…";
    const qs = force ? "?refresh=1" : "";
    const data = await api(`/api/zoho/ui/users${qs}`);
    state.users = data.users || [];
    state.scopes = data.scopes || "";
    state.consoleUrl = data.consoleUrl || state.consoleUrl;
    const cacheNote = data.cached ? " (cached)" : " (fresh from Zoho)";
    el.stats.textContent = `${data.connectedCount}/${data.total} connected${cacheNote}`;
    renderUsers();
    renderDetail();
  }

  function selectUser(email) {
    state.selectedEmail = email;
    state.inbox = null;
    state.messages = [];
    state.nextStart = 1;
    state.hasMore = false;
    el.codeInput.value = "";
    el.messageList.innerHTML = "";
    el.messageBody.innerHTML =
      '<p class="muted">Select a message to view the body.</p>';
    el.mailLayout.classList.add("hidden");
    if (el.loadMoreBtn) el.loadMoreBtn.classList.add("hidden");
    if (el.inboxMeta) el.inboxMeta.textContent = "";
    renderUsers();
    renderDetail();
  }

  async function connectMailbox() {
    const user = selectedUser();
    if (!user) return;

    const code = el.codeInput.value.trim();
    if (!code) {
      showToast("Paste the Self Client code first.", "err");
      return;
    }

    el.connectBtn.disabled = true;
    el.connectBtn.textContent = "Connecting…";
    try {
      const result = await api("/api/zoho/mailboxes/connect", {
        method: "POST",
        body: JSON.stringify({ code, expectedEmail: user.email }),
      });
      showToast(`Connected ${result.mailbox.email}`, "ok");
      el.codeInput.value = "";
      await loadUsers();
      state.selectedEmail = result.mailbox.email;
      renderUsers();
      renderDetail();
    } catch (error) {
      showToast(error.message || String(error), "err");
    } finally {
      el.connectBtn.disabled = false;
      el.connectBtn.textContent = "Connect with pasted code";
    }
  }

  async function fetchInboxPage(start, { append }) {
    const user = selectedUser();
    if (!user?.connected) return;

    const qs = new URLSearchParams({
      email: user.email,
      limit: String(PAGE_SIZE),
      start: String(start),
    });
    const data = await api(`/api/zoho/ui/inbox?${qs}`);

    state.inbox = {
      email: data.email,
      accountId: data.accountId,
      inbox: data.folder || data.inbox,
      view: data.view,
    };
    state.messages = append
      ? [...state.messages, ...(data.messages || [])]
      : data.messages || [];
    state.hasMore = Boolean(data.hasMore);
    state.nextStart = data.nextStart || start + (data.messages?.length || 0);
    state.totalMatched = data.totalMatched || state.messages.length;

    el.mailLayout.classList.remove("hidden");
    renderMessageList({ resetBody: !append });
    updateInboxMeta();
    return data;
  }

  function updateInboxMeta() {
    if (!el.inboxMeta) return;
    el.inboxMeta.textContent = state.messages.length
      ? `· ${state.messages.length}${
          state.totalMatched ? `/${state.totalMatched}` : ""
        } loaded · latest → older · all folders`
      : "";
    if (el.loadMoreBtn) {
      el.loadMoreBtn.classList.toggle("hidden", !state.hasMore);
      el.loadMoreBtn.disabled = state.loadingMore;
      el.loadMoreBtn.textContent = state.loadingMore
        ? "Loading…"
        : "Load more";
    }
  }

  async function readMails() {
    const user = selectedUser();
    if (!user?.connected) return;

    el.readMailsBtn.disabled = true;
    el.readMailsBtn.textContent = "Loading…";
    try {
      const data = await fetchInboxPage(1, { append: false });
      showToast(
        `Loaded ${data.count} messages (latest → older)`,
        "ok"
      );
    } catch (error) {
      showToast(error.message || String(error), "err");
    } finally {
      el.readMailsBtn.disabled = false;
      el.readMailsBtn.textContent = "Read mails";
    }
  }

  async function loadMoreMails() {
    if (!state.hasMore || state.loadingMore) return;
    state.loadingMore = true;
    updateInboxMeta();
    try {
      const data = await fetchInboxPage(state.nextStart, { append: true });
      showToast(`Loaded ${data.count} more · total ${state.messages.length}`, "ok");
    } catch (error) {
      showToast(error.message || String(error), "err");
    } finally {
      state.loadingMore = false;
      updateInboxMeta();
    }
  }

  function renderMessageList({ resetBody = true } = {}) {
    el.messageList.innerHTML = "";
    if (resetBody) {
      el.messageBody.innerHTML =
        '<p class="muted">Select a message to view the body.</p>';
    }

    if (!state.messages.length) {
      el.messageList.innerHTML =
        '<p class="muted" style="padding:0.75rem">Inbox is empty.</p>';
      updateInboxMeta();
      return;
    }

    for (const msg of state.messages) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-item";
      const when = formatTime(msg.receivedTime);
      btn.innerHTML = `
        <div class="subject">${escapeHtml(msg.subject || "(no subject)")}</div>
        <div class="from">${escapeHtml(stripQuotes(msg.from || ""))}</div>
        <div class="when">${escapeHtml(when)}${msg.hasAttachment ? " · 📎" : ""}</div>`;
      btn.addEventListener("click", () => {
        el.messageList
          .querySelectorAll(".msg-item")
          .forEach((n) => n.classList.remove("active"));
        btn.classList.add("active");
        loadMessageBody(msg);
      });
      el.messageList.appendChild(btn);
    }
    updateInboxMeta();
  }

  async function loadMessageBody(msg) {
    const user = selectedUser();
    const inbox = state.inbox;
    if (!user || !inbox) return;

    const folderId = msg.folderId || inbox.inbox?.folderId;
    if (!folderId) {
      el.messageBody.innerHTML =
        '<p class="toast err">Missing folderId for this message — cannot load body.</p>';
      return;
    }

    el.messageBody.innerHTML = '<p class="muted">Loading body…</p>';
    try {
      const qs = new URLSearchParams({
        email: user.email,
        accountId: inbox.accountId,
        folderId,
        messageId: msg.messageId,
      });
      const data = await api(`/api/zoho/ui/message?${qs}`);
      const m = data.message;
      const html = m.htmlContent || "";
      const text = m.textContent || "";

      el.messageBody.innerHTML = `
        <h3>${escapeHtml(m.subject || "(no subject)")}</h3>
        <div class="meta-line">
          From: ${escapeHtml(stripQuotes(m.from || ""))}<br/>
          To: ${escapeHtml(stripQuotes(m.to || ""))}
        </div>
        ${
          html
            ? `<div class="body-html">${sanitizeHtml(html)}</div>`
            : `<pre class="body-text">${escapeHtml(text || "(empty body)")}</pre>`
        }`;
    } catch (error) {
      el.messageBody.innerHTML = `<p class="toast err">${escapeHtml(
        error.message || String(error)
      )}</p>`;
    }
  }

  function formatTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    // Zoho sometimes returns ms epoch; sometimes slightly odd values — Date handles both reasonably.
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  }

  function stripQuotes(value) {
    return String(value)
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Basic sanitizer: drop scripts/handlers for display-only HTML bodies.
  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content
      .querySelectorAll("script, iframe, object, embed")
      .forEach((n) => n.remove());
    template.content.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attr) => {
        if (/^on/i.test(attr.name) || attr.name === "srcdoc") {
          node.removeAttribute(attr.name);
        }
        if (
          (attr.name === "href" || attr.name === "src") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          node.removeAttribute(attr.name);
        }
      });
    });
    return template.innerHTML;
  }

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document
        .querySelectorAll(".chip")
        .forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.filter = chip.dataset.filter || "all";
      renderUsers();
    });
  });

  el.search.addEventListener("input", () => {
    state.search = el.search.value;
    renderUsers();
  });
  el.connectBtn.addEventListener("click", connectMailbox);
  el.readMailsBtn.addEventListener("click", readMails);
  if (el.loadMoreBtn) {
    el.loadMoreBtn.addEventListener("click", loadMoreMails);
  }
  el.refreshUsers.addEventListener("click", () => {
    loadUsers(true).catch((e) => showToast(e.message, "err"));
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("ok") === "1" && params.get("connected")) {
    const email = params.get("connected");
    showToast(`Connected ${email}`, "ok");
    state.selectedEmail = email;
    history.replaceState({}, "", "/");
  }

  loadUsers().catch((error) => {
    el.stats.textContent = "Failed to load users";
    showToast(error.message || String(error), "err");
  });
})();
