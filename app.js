/* =========================================================================
 * NAVY_BLUE Revenue Deck
 * 副業映像制作の案件・収益・入金管理ダッシュボード
 *
 * - LocalStorage を基本ストレージとし、設定すれば Supabase 同期も可能
 * - Phase 1: 案件登録 / ステータス管理 / 月次・未入金集計
 * - Phase 2: 月別入金グラフ / 月間目標の進捗バー
 * - Phase 3: 請求書プレビュー / 印刷・PDF 出力
 * ========================================================================= */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
   * 定数・設定
   * ------------------------------------------------------------------- */
  const STORAGE_KEY = "navyRevenueDeck.projects.v1";
  const GOAL_KEY = "navyRevenueDeck.monthlyGoal.v1";
  const SUPA_CONFIG_KEY = "navyRevenueDeck.supabaseConfig.v1";
  const TAX_RATE = 0.1;
  const DEFAULT_GOAL = 300000; // 副業の月間目標（既定 ¥300,000）

  // 案件ステータスの定義（順序がそのままワークフロー）
  const STATUS_FLOW = ["lead", "ordered", "producing", "delivered", "invoiced", "paid"];
  const STATUS_LABEL = {
    lead: "商談中",
    ordered: "受注",
    producing: "制作中",
    delivered: "納品済み",
    invoiced: "請求済み",
    paid: "入金済み",
  };
  // 「次へ」ボタンを押したときに自動で日付を埋める対応
  const STATUS_DATE_FIELD = {
    ordered: "orderedAt",
    invoiced: "invoicedAt",
    paid: "paidAt",
  };

  const PROJECT_TYPES = [
    "ショート動画編集",
    "YouTube編集",
    "企業VP / PR動画",
    "ウェディングムービー",
    "MV / ミュージックビデオ",
    "モーショングラフィックス",
    "撮影",
    "その他",
  ];

  const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  /* ---------------------------------------------------------------------
   * DOM 参照
   * ------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    todayLabel: $("todayLabel"),
    yearTotalLabel: $("yearTotalLabel"),
    yearLabel: $("yearLabel"),
    monthIncome: $("monthIncome"),
    monthIncomeSub: $("monthIncomeSub"),
    goalRate: $("goalRate"),
    goalSub: $("goalSub"),
    unpaidAmount: $("unpaidAmount"),
    unpaidSub: $("unpaidSub"),
    goalInput: $("goalInput"),
    progressBar: $("progressBar"),
    progressFill: $("progressFill"),
    progressText: $("progressText"),
    // cloud
    cloudPanel: $("cloudPanel"),
    cloudStatus: $("cloudStatus"),
    supabaseUrl: $("supabaseUrl"),
    supabaseAnonKey: $("supabaseAnonKey"),
    loginEmail: $("loginEmail"),
    saveSupabaseButton: $("saveSupabaseButton"),
    loginButton: $("loginButton"),
    syncLocalButton: $("syncLocalButton"),
    logoutButton: $("logoutButton"),
    // form
    projectForm: $("projectForm"),
    formTitle: $("formTitle"),
    seedButton: $("seedButton"),
    clientName: $("clientName"),
    projectType: $("projectType"),
    amount: $("amount"),
    status: $("status"),
    orderedAt: $("orderedAt"),
    deadline: $("deadline"),
    invoicedAt: $("invoicedAt"),
    paidAt: $("paidAt"),
    memo: $("memo"),
    submitButton: $("submitButton"),
    cancelEditButton: $("cancelEditButton"),
    // board
    focusList: $("focusList"),
    csvButton: $("csvButton"),
    copyObsidianButton: $("copyObsidianButton"),
    chartWrap: $("chartWrap"),
    chartYearBadge: $("chartYearBadge"),
    activeList: $("activeList"),
    activeBadge: $("activeBadge"),
    paidList: $("paidList"),
    paidBadge: $("paidBadge"),
    // misc
    toast: $("toast"),
    projectTemplate: $("projectTemplate"),
    // invoice
    invoiceOverlay: $("invoiceOverlay"),
    invoiceSheet: $("invoiceSheet"),
    printInvoiceButton: $("printInvoiceButton"),
    closeInvoiceButton: $("closeInvoiceButton"),
  };

  /* ---------------------------------------------------------------------
   * 状態
   * ------------------------------------------------------------------- */
  let projects = [];
  let monthlyGoal = DEFAULT_GOAL;
  let editingId = null;
  let toastTimer = null;
  let invoiceTrigger = null;

  // Supabase（任意）
  let supaConfig = { url: "", anonKey: "", email: "" };
  let supabaseClient = null;
  let currentUser = null;

  /* ---------------------------------------------------------------------
   * ユーティリティ
   * ------------------------------------------------------------------- */
  const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");

  // ローカルタイムの日付を YYYY-MM-DD で返す（UTC変換による1日ズレを防ぐ）
  const fmtISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const todayISO = () => fmtISO(new Date());

  const uid = () =>
    (crypto && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  const parseISO = (s) => {
    if (!s) return null;
    const d = new Date(s + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const daysUntil = (iso) => {
    const d = parseISO(iso);
    if (!d) return null;
    const now = parseISO(todayISO());
    return Math.round((d - now) / 86400000);
  };

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function showToast(message, ms = 2600) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), ms);
  }

  /* ---------------------------------------------------------------------
   * 正規化
   * ------------------------------------------------------------------- */
  function normalizeProject(raw) {
    const p = raw || {};
    const status = STATUS_FLOW.includes(p.status) ? p.status : "lead";
    const updatedAt = p.updatedAt || new Date().toISOString();
    // 入金済みなのに入金日が無い場合は、更新日を入金日として確定させる。
    // （集計を updatedAt にフォールバックすると、後で編集する度に売上が当月へ移動してしまうため、
    //   一度だけ具体的な日付に固定する。）
    let paidAt = p.paidAt || "";
    if (status === "paid" && !paidAt) paidAt = updatedAt.slice(0, 10);
    return {
      id: p.id || uid(),
      clientName: String(p.clientName ?? "").trim(),
      projectType: String(p.projectType ?? PROJECT_TYPES[0]),
      amount: Math.max(0, Math.round(Number(p.amount) || 0)),
      status,
      orderedAt: p.orderedAt || "",
      deadline: p.deadline || "",
      invoicedAt: p.invoicedAt || "",
      paidAt,
      memo: String(p.memo ?? ""),
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt,
    };
  }

  /* ---------------------------------------------------------------------
   * 永続化（LocalStorage）
   * ------------------------------------------------------------------- */
  function loadLocal() {
    try {
      const rawP = localStorage.getItem(STORAGE_KEY);
      const parsed = rawP ? JSON.parse(rawP) : [];
      projects = Array.isArray(parsed) ? parsed.map(normalizeProject) : [];
    } catch {
      projects = [];
    }
    try {
      const g = localStorage.getItem(GOAL_KEY);
      monthlyGoal = g ? Math.max(0, Math.round(Number(g) || 0)) : DEFAULT_GOAL;
    } catch {
      monthlyGoal = DEFAULT_GOAL;
    }
    try {
      const c = localStorage.getItem(SUPA_CONFIG_KEY);
      if (c) supaConfig = { ...supaConfig, ...JSON.parse(c) };
    } catch {
      /* noop */
    }
  }

  function saveProjectsLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch {
      showToast("ローカル保存に失敗しました（容量超過の可能性）");
    }
  }

  function saveGoalLocal() {
    try {
      localStorage.setItem(GOAL_KEY, String(monthlyGoal));
    } catch {
      /* noop */
    }
  }

  function saveSupaConfigLocal() {
    try {
      // anonKey はブラウザ内のみ保存（公開用キー前提）
      localStorage.setItem(SUPA_CONFIG_KEY, JSON.stringify(supaConfig));
    } catch {
      /* noop */
    }
  }

  /* ---------------------------------------------------------------------
   * 集計
   * ------------------------------------------------------------------- */
  // 入金として確定した売上か（paid かつ入金日あり）
  const isPaid = (p) => p.status === "paid";
  // 受注済みだが未回収（lead を除く未入金）
  const isUnpaidPipeline = (p) => p.status !== "paid" && p.status !== "lead";

  function paidDateOf(p) {
    // normalizeProject で paid 案件には必ず paidAt が入る前提
    return p.paidAt || "";
  }

  function sumMonthIncome(year, month) {
    return projects.reduce((acc, p) => {
      if (!isPaid(p)) return acc;
      const d = parseISO(paidDateOf(p));
      if (d && d.getFullYear() === year && d.getMonth() === month) return acc + p.amount;
      return acc;
    }, 0);
  }

  function sumYearIncome(year) {
    return projects.reduce((acc, p) => {
      if (!isPaid(p)) return acc;
      const d = parseISO(paidDateOf(p));
      if (d && d.getFullYear() === year) return acc + p.amount;
      return acc;
    }, 0);
  }

  // 未入金は実際に回収する金額＝税込で見込む（資金繰り視点）
  function sumUnpaid() {
    return projects.filter(isUnpaidPipeline).reduce((acc, p) => acc + Math.round(p.amount * (1 + TAX_RATE)), 0);
  }

  function monthlySeries(year) {
    const series = new Array(12).fill(0);
    projects.forEach((p) => {
      if (!isPaid(p)) return;
      const d = parseISO(paidDateOf(p));
      if (d && d.getFullYear() === year) series[d.getMonth()] += p.amount;
    });
    return series;
  }

  /* ---------------------------------------------------------------------
   * 描画
   * ------------------------------------------------------------------- */
  function renderAll() {
    renderSummary();
    renderGoal();
    renderChart();
    renderLists();
    renderFocus();
  }

  function renderSummary() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();

    el.todayLabel.textContent = now.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });

    const yearTotal = sumYearIncome(y);
    el.yearTotalLabel.textContent = yen(yearTotal);
    el.yearLabel.textContent = `${y}年の入金累計`;

    const monthInc = sumMonthIncome(y, m);
    el.monthIncome.textContent = yen(monthInc);
    const monthPaidCount = projects.filter((p) => {
      const d = parseISO(paidDateOf(p));
      return isPaid(p) && d && d.getFullYear() === y && d.getMonth() === m;
    }).length;
    el.monthIncomeSub.textContent = monthPaidCount ? `${monthPaidCount}件の入金確定` : "確定した売上";

    const rate = monthlyGoal > 0 ? Math.round((monthInc / monthlyGoal) * 100) : 0;
    el.goalRate.textContent = `${rate}%`;
    el.goalSub.textContent = `目標 ${yen(monthlyGoal)}`;

    const unpaid = sumUnpaid();
    el.unpaidAmount.textContent = yen(unpaid);
    const unpaidCount = projects.filter(isUnpaidPipeline).length;
    el.unpaidSub.textContent = unpaidCount ? `${unpaidCount}件 受注済み・未回収（税込）` : "受注済み・未回収（税込）";
  }

  function renderGoal() {
    if (document.activeElement !== el.goalInput) {
      el.goalInput.value = String(monthlyGoal);
    }
    const now = new Date();
    const monthInc = sumMonthIncome(now.getFullYear(), now.getMonth());
    const pct = monthlyGoal > 0 ? (monthInc / monthlyGoal) * 100 : 0;
    const clamped = Math.max(0, Math.min(100, pct));

    el.progressFill.style.width = `${clamped}%`;
    el.progressFill.classList.toggle("over", pct >= 100);
    el.progressText.textContent = `${yen(monthInc)} / ${yen(monthlyGoal)}`;
    el.progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
    el.progressBar.setAttribute("aria-valuetext", `${yen(monthInc)} / ${yen(monthlyGoal)}（${Math.round(pct)}%）`);
  }

  function renderChart() {
    const now = new Date();
    const y = now.getFullYear();
    const curMonth = now.getMonth();
    const series = monthlySeries(y);
    const max = Math.max(1, ...series);

    el.chartYearBadge.textContent = `${y}年`;
    el.chartWrap.innerHTML = "";

    series.forEach((value, i) => {
      const col = document.createElement("div");
      col.className = "chart-col";

      const track = document.createElement("div");
      track.className = "chart-bar-track";

      const bar = document.createElement("div");
      bar.className = "chart-bar" + (i === curMonth ? " current" : "");
      bar.style.height = `${Math.round((value / max) * 100)}%`;
      bar.title = `${MONTH_LABELS[i]}: ${yen(value)}`;

      if (value > 0) {
        const v = document.createElement("span");
        v.className = "chart-bar-value";
        v.textContent = value >= 10000 ? `${Math.round(value / 10000)}万` : yen(value);
        bar.appendChild(v);
      }

      track.appendChild(bar);

      const label = document.createElement("div");
      label.className = "chart-label" + (i === curMonth ? " current" : "");
      label.textContent = MONTH_LABELS[i];

      col.appendChild(track);
      col.appendChild(label);
      el.chartWrap.appendChild(col);
    });
  }

  function nextActionInfo(p) {
    // カードに表示する「次にやること」とアラート判定
    switch (p.status) {
      case "lead":
        return { text: "見積・提案を進める", alert: false };
      case "ordered":
        return { text: "制作に着手", alert: false };
      case "producing": {
        const d = daysUntil(p.deadline);
        if (d === null) return { text: "納期を設定", alert: false };
        if (d < 0) return { text: `納期 ${-d}日超過`, alert: true };
        if (d === 0) return { text: "本日が納期", alert: true };
        if (d <= 3) return { text: `納期まであと${d}日`, alert: true };
        return { text: `納期まであと${d}日`, alert: false };
      }
      case "delivered":
        return { text: "請求書を発行", alert: false };
      case "invoiced": {
        const d = daysUntil(p.invoicedAt ? addDaysISO(p.invoicedAt, 30) : "");
        if (d !== null && d < 0) return { text: "入金期日を超過", alert: true };
        return { text: "入金を確認", alert: false };
      }
      case "paid":
        return { text: p.paidAt ? `${p.paidAt} 入金済み` : "入金済み", alert: false };
      default:
        return { text: "", alert: false };
    }
  }

  function addDaysISO(iso, days) {
    const d = parseISO(iso);
    if (!d) return "";
    d.setDate(d.getDate() + days);
    return fmtISO(d);
  }

  function buildMeta(p) {
    const parts = [p.projectType];
    if (p.orderedAt) parts.push(`受注 ${p.orderedAt}`);
    if (p.deadline) parts.push(`納期 ${p.deadline}`);
    if (p.status === "invoiced" && p.invoicedAt) parts.push(`請求 ${p.invoicedAt}`);
    return parts.join("　/　");
  }

  function renderLists() {
    const active = projects.filter((p) => p.status !== "paid");
    const paid = projects.filter((p) => p.status === "paid");

    // 進行中: ステータス進行順 → 納期が近い順
    active.sort((a, b) => {
      const sa = STATUS_FLOW.indexOf(a.status);
      const sb = STATUS_FLOW.indexOf(b.status);
      if (sa !== sb) return sa - sb;
      const da = parseISO(a.deadline)?.getTime() ?? Infinity;
      const db = parseISO(b.deadline)?.getTime() ?? Infinity;
      return da - db;
    });
    // 入金済み: 入金日の新しい順
    paid.sort((a, b) => (parseISO(paidDateOf(b)) ?? 0) - (parseISO(paidDateOf(a)) ?? 0));

    el.activeBadge.textContent = String(active.length);
    el.paidBadge.textContent = String(paid.length);

    renderListInto(el.activeList, active, "進行中の案件はありません。左のフォームから追加できます。");
    renderListInto(el.paidList, paid, "まだ入金済みの案件はありません。");
  }

  function renderListInto(container, list, emptyMessage) {
    container.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach((p) => frag.appendChild(buildCard(p)));
    container.appendChild(frag);
  }

  function buildCard(p) {
    const node = el.projectTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = p.id;
    node.dataset.state = p.status;

    const overdue =
      p.status === "producing" && (() => {
        const d = daysUntil(p.deadline);
        return d !== null && d < 0;
      })();
    node.classList.toggle("overdue", !!overdue);

    node.querySelector(".project-client").textContent = p.clientName || "（無名の案件）";
    node.querySelector(".project-amount").textContent = yen(p.amount);
    node.querySelector(".project-meta").textContent = buildMeta(p);

    const chip = node.querySelector(".status-chip");
    chip.textContent = STATUS_LABEL[p.status];
    chip.dataset.state = p.status;

    const na = nextActionInfo(p);
    const naEl = node.querySelector(".next-action");
    naEl.textContent = na.text;
    naEl.classList.toggle("alert", na.alert);

    const memoEl = node.querySelector(".project-memo");
    if (p.memo) {
      memoEl.textContent = p.memo;
    } else {
      memoEl.remove();
    }

    // ステップボタンのラベル
    const stepBtn = node.querySelector(".step-button");
    const nextIdx = STATUS_FLOW.indexOf(p.status) + 1;
    if (nextIdx < STATUS_FLOW.length) {
      stepBtn.textContent = `${STATUS_LABEL[STATUS_FLOW[nextIdx]]} ▶`;
      stepBtn.title = `「${STATUS_LABEL[STATUS_FLOW[nextIdx]]}」へ進める`;
    }

    return node;
  }

  function renderFocus() {
    // 納期が近い順 TOP3（進行中・納期あり）
    const upcoming = projects
      .filter((p) => p.status !== "paid" && p.deadline)
      .map((p) => ({ p, d: daysUntil(p.deadline) }))
      .filter((x) => x.d !== null)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);

    el.focusList.innerHTML = "";
    if (!upcoming.length) {
      const li = document.createElement("li");
      li.textContent = "納期が設定された案件はありません";
      el.focusList.appendChild(li);
      return;
    }
    upcoming.forEach(({ p, d }) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${p.clientName || "（無名）"}（${yen(p.amount)}）`;
      const span = document.createElement("span");
      let when;
      if (d < 0) when = `納期 ${-d}日超過`;
      else if (d === 0) when = "本日が納期";
      else when = `あと${d}日 (${p.deadline})`;
      span.textContent = `${STATUS_LABEL[p.status]}・${when}`;
      li.appendChild(strong);
      li.appendChild(span);
      el.focusList.appendChild(li);
    });
  }

  /* ---------------------------------------------------------------------
   * フォーム
   * ------------------------------------------------------------------- */
  function populateSelects() {
    el.projectType.innerHTML = PROJECT_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    el.status.innerHTML = STATUS_FLOW.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("");
  }

  function resetForm() {
    editingId = null;
    el.projectForm.reset();
    el.projectForm.classList.remove("editing");
    el.formTitle.textContent = "案件を追加";
    el.submitButton.textContent = "案件を追加";
    el.cancelEditButton.hidden = true;
    el.orderedAt.value = todayISO();
  }

  function fillForm(p) {
    el.clientName.value = p.clientName;
    el.projectType.value = p.projectType;
    el.amount.value = p.amount || "";
    el.status.value = p.status;
    el.orderedAt.value = p.orderedAt;
    el.deadline.value = p.deadline;
    el.invoicedAt.value = p.invoicedAt;
    el.paidAt.value = p.paidAt;
    el.memo.value = p.memo;
  }

  function startEdit(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    editingId = id;
    fillForm(p);
    el.projectForm.classList.add("editing");
    el.formTitle.textContent = "案件を編集";
    el.submitButton.textContent = "変更を保存";
    el.cancelEditButton.hidden = false;
    el.projectForm.scrollIntoView({ behavior: "smooth", block: "start" });
    el.clientName.focus();
  }

  function readForm() {
    return normalizeProject({
      id: editingId || uid(),
      clientName: el.clientName.value,
      projectType: el.projectType.value,
      amount: el.amount.value,
      status: el.status.value,
      orderedAt: el.orderedAt.value,
      deadline: el.deadline.value,
      invoicedAt: el.invoicedAt.value,
      paidAt: el.paidAt.value,
      memo: el.memo.value,
      createdAt: editingId ? projects.find((x) => x.id === editingId)?.createdAt : undefined,
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const data = readForm();
    if (!data.clientName) {
      showToast("クライアント名を入力してください");
      el.clientName.focus();
      return;
    }
    if (data.amount <= 0) {
      showToast("金額を入力してください");
      el.amount.focus();
      return;
    }
    // ステータスが paid なのに入金日が空なら本日を補完
    if (data.status === "paid" && !data.paidAt) data.paidAt = todayISO();
    if (data.status === "invoiced" && !data.invoicedAt) data.invoicedAt = todayISO();
    data.updatedAt = new Date().toISOString();

    if (editingId) {
      const idx = projects.findIndex((x) => x.id === editingId);
      if (idx >= 0) projects[idx] = data;
      showToast("案件を更新しました");
    } else {
      projects.unshift(data);
      showToast("案件を追加しました");
    }
    persistAndRender();
    upsertRemote(data);
    resetForm();
  }

  /* ---------------------------------------------------------------------
   * カード操作
   * ------------------------------------------------------------------- */
  function stepStatus(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    const idx = STATUS_FLOW.indexOf(p.status);
    if (idx < 0 || idx >= STATUS_FLOW.length - 1) return;
    const next = STATUS_FLOW[idx + 1];
    p.status = next;
    // 関連日付の自動補完
    const field = STATUS_DATE_FIELD[next];
    if (field && !p[field]) p[field] = todayISO();
    p.updatedAt = new Date().toISOString();
    showToast(`「${p.clientName || "案件"}」を ${STATUS_LABEL[next]} に進めました`);
    persistAndRender();
    upsertRemote(p);
  }

  function deleteProject(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`「${p.clientName || "この案件"}」を削除しますか？`)) return;
    projects = projects.filter((x) => x.id !== id);
    if (editingId === id) resetForm();
    showToast("案件を削除しました");
    persistAndRender();
    deleteRemote(id);
  }

  function persistAndRender() {
    saveProjectsLocal();
    renderAll();
  }

  /* ---------------------------------------------------------------------
   * Phase 3: 請求書
   * ------------------------------------------------------------------- */
  function openInvoice(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    const subtotal = p.amount;
    const tax = Math.round(subtotal * TAX_RATE);
    const total = subtotal + tax;
    const issueDate = p.invoicedAt || todayISO();
    const dueDate = addDaysISO(issueDate, 30);
    const invoiceNo = `NB-${issueDate.replace(/-/g, "")}-${p.id.slice(0, 4).toUpperCase()}`;

    el.invoiceSheet.innerHTML = `
      <div class="inv-header">
        <div>
          <h2>請求書</h2>
        </div>
        <div class="inv-brand">
          <div class="inv-logo">NAVY_BLUE</div>
          <p>映像制作 / Video Production<br />Invoice No. ${escapeHtml(invoiceNo)}</p>
        </div>
      </div>

      <div class="inv-to">${escapeHtml(p.clientName || "御中")} 御中</div>

      <div class="inv-meta">
        <div>発行日：${escapeHtml(issueDate)}</div>
        <div>お支払期限：${escapeHtml(dueDate)}</div>
      </div>

      <div class="inv-total-box">
        <span>ご請求金額（税込）</span>
        <strong>${yen(total)}</strong>
      </div>

      <table class="inv-table">
        <thead>
          <tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>${escapeHtml(p.projectType)}${p.memo ? "（" + escapeHtml(p.memo) + "）" : ""}</td>
            <td>1</td>
            <td>${yen(subtotal)}</td>
            <td>${yen(subtotal)}</td>
          </tr>
        </tbody>
      </table>

      <div class="inv-summary">
        <div><span>小計</span><span>${yen(subtotal)}</span></div>
        <div><span>消費税（10%）</span><span>${yen(tax)}</span></div>
        <div class="inv-grand"><span>合計</span><span>${yen(total)}</span></div>
      </div>

      <div class="inv-note">
        お振込手数料は貴社にてご負担いただけますようお願い申し上げます。<br />
        ※この請求書は NAVY_BLUE Revenue Deck で作成されたプレビューです。振込先・登録番号等は実際の発行時にご記入ください。
      </div>
    `;

    el.invoiceOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    // 背景を支援技術から隠し、フォーカスをモーダルへ移す
    document.querySelector(".app-shell")?.setAttribute("aria-hidden", "true");
    invoiceTrigger = document.activeElement;
    el.closeInvoiceButton.focus();
  }

  function closeInvoice() {
    el.invoiceOverlay.hidden = true;
    document.body.style.overflow = "";
    document.querySelector(".app-shell")?.removeAttribute("aria-hidden");
    // 開いたボタンへフォーカスを戻す
    if (invoiceTrigger && document.contains(invoiceTrigger)) invoiceTrigger.focus();
    invoiceTrigger = null;
  }

  // モーダル内で Tab を循環させる（フォーカストラップ）
  function trapInvoiceFocus(e) {
    if (e.key !== "Tab" || el.invoiceOverlay.hidden) return;
    const focusables = el.invoiceOverlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------------
   * CSV / サマリー
   * ------------------------------------------------------------------- */
  // CSV インジェクション対策：先頭が = + - @ などのセルを ' で無害化
  function csvCell(value) {
    let s = String(value ?? "");
    // 先頭（空白を挟む場合も含む）が数式文字なら ' で無害化
    if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv() {
    const header = ["クライアント名", "案件種別", "金額(税抜)", "消費税", "税込", "ステータス", "受注日", "納期", "請求日", "入金日", "メモ"];
    const rows = projects.map((p) => {
      const tax = Math.round(p.amount * TAX_RATE);
      return [
        p.clientName,
        p.projectType,
        p.amount,
        tax,
        p.amount + tax,
        STATUS_LABEL[p.status],
        p.orderedAt,
        p.deadline,
        p.invoicedAt,
        p.paidAt,
        p.memo,
      ].map(csvCell).join(",");
    });
    return "\uFEFF" + [header.map(csvCell).join(","), ...rows].join("\r\n");
  }

  function exportCsv() {
    if (!projects.length) {
      showToast("出力する案件がありません");
      return;
    }
    const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `navy-revenue-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("CSVを書き出しました");
  }

  function buildMonthlySummaryMarkdown() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const monthInc = sumMonthIncome(y, m);
    const yearInc = sumYearIncome(y);
    const unpaid = sumUnpaid();
    const rate = monthlyGoal > 0 ? Math.round((monthInc / monthlyGoal) * 100) : 0;

    const activeRows = projects
      .filter((p) => p.status !== "paid")
      .sort((a, b) => STATUS_FLOW.indexOf(a.status) - STATUS_FLOW.indexOf(b.status))
      .map((p) => `- ${p.clientName}（${STATUS_LABEL[p.status]}）${yen(p.amount)}${p.deadline ? ` / 納期 ${p.deadline}` : ""}`);

    const paidThisMonth = projects.filter((p) => {
      const d = parseISO(paidDateOf(p));
      return isPaid(p) && d && d.getFullYear() === y && d.getMonth() === m;
    });

    return [
      `## ${y}年${m + 1}月 副業収益サマリー`,
      "",
      `- 今月の入金: **${yen(monthInc)}**（目標 ${yen(monthlyGoal)} / 達成率 ${rate}%）`,
      `- 今年の入金累計: ${yen(yearInc)}`,
      `- 未入金（受注済み・未回収）: ${yen(unpaid)}`,
      "",
      `### 今月入金された案件（${paidThisMonth.length}件）`,
      paidThisMonth.length
        ? paidThisMonth.map((p) => `- ${p.clientName} ${yen(p.amount)}${p.paidAt ? `（${p.paidAt}）` : ""}`).join("\n")
        : "- なし",
      "",
      `### 進行中の案件（${activeRows.length}件）`,
      activeRows.length ? activeRows.join("\n") : "- なし",
    ].join("\n");
  }

  async function copyMonthlySummary() {
    const md = buildMonthlySummaryMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      showToast("月次サマリーをコピーしました（Obsidianに貼り付け可）");
    } catch {
      // フォールバック
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("月次サマリーをコピーしました");
      } catch {
        showToast("コピーに失敗しました");
      }
      ta.remove();
    }
  }

  /* ---------------------------------------------------------------------
   * サンプル投入
   * ------------------------------------------------------------------- */
  function seedSamples() {
    if (projects.length && !confirm("サンプル案件を追加しますか？（既存の案件は残ります）")) return;
    const t = todayISO();
    const samples = [
      { clientName: "ノバセル", projectType: "ショート動画編集", amount: 80000, status: "producing", orderedAt: addDaysISO(t, -10), deadline: addDaysISO(t, 2), memo: "縦型30秒×3本" },
      { clientName: "イチカバチカ", projectType: "YouTube編集", amount: 50000, status: "delivered", orderedAt: addDaysISO(t, -18), deadline: addDaysISO(t, -2), memo: "テロップ・カット込み" },
      { clientName: "結婚式 田中様", projectType: "ウェディングムービー", amount: 120000, status: "invoiced", orderedAt: addDaysISO(t, -40), invoicedAt: addDaysISO(t, -5), memo: "オープニング+プロフィール" },
      { clientName: "株式会社アオゾラ", projectType: "企業VP / PR動画", amount: 250000, status: "paid", orderedAt: addDaysISO(t, -60), invoicedAt: addDaysISO(t, -30), paidAt: addDaysISO(t, -3), memo: "会社紹介3分" },
      { clientName: "Café LUMO", projectType: "撮影", amount: 40000, status: "lead", deadline: addDaysISO(t, 14), memo: "メニュー撮影の相談中" },
    ].map(normalizeProject);
    projects = samples.concat(projects);
    showToast("サンプル案件を追加しました");
    persistAndRender();
    samples.forEach(upsertRemote);
  }

  /* ---------------------------------------------------------------------
   * Supabase 同期（任意）
   * ------------------------------------------------------------------- */
  function toDbRow(p) {
    return {
      id: p.id,
      client_name: p.clientName,
      project_type: p.projectType,
      amount: p.amount,
      status: p.status,
      ordered_at: p.orderedAt || null,
      deadline: p.deadline || null,
      invoiced_at: p.invoicedAt || null,
      paid_at: p.paidAt || null,
      memo: p.memo,
      created_at: p.createdAt,
      // updated_at はDBトリガが書込時刻で上書きするため、競合解決には使わない。
      // クライアントの編集時刻を別カラムに保持してマージ判定に使う。
      client_updated_at: p.updatedAt,
      user_id: currentUser?.id,
    };
  }

  function fromDbRow(r) {
    return normalizeProject({
      id: r.id,
      clientName: r.client_name,
      projectType: r.project_type,
      amount: r.amount,
      status: r.status,
      orderedAt: r.ordered_at || "",
      deadline: r.deadline || "",
      invoicedAt: r.invoiced_at || "",
      paidAt: r.paid_at || "",
      memo: r.memo || "",
      createdAt: r.created_at,
      updatedAt: r.client_updated_at || r.updated_at,
    });
  }

  function cloudEnabled() {
    return !!(supabaseClient && currentUser);
  }

  function initSupabaseClient() {
    if (!supaConfig.url || !supaConfig.anonKey) return false;
    if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
      return false;
    }
    try {
      supabaseClient = window.supabase.createClient(supaConfig.url, supaConfig.anonKey);
      return true;
    } catch {
      supabaseClient = null;
      return false;
    }
  }

  function setCloudStatus(text) {
    if (el.cloudStatus) el.cloudStatus.textContent = text;
  }

  async function refreshSession() {
    if (!supabaseClient) return;
    try {
      const { data } = await supabaseClient.auth.getSession();
      currentUser = data?.session?.user || null;
      if (currentUser) {
        setCloudStatus(`ログイン中: ${currentUser.email || ""}（クラウド同期ON）`);
        await pullRemote();
      } else {
        setCloudStatus("Supabase設定済み: ログインするとクラウド同期します");
      }
    } catch {
      setCloudStatus("セッション確認に失敗しました");
    }
  }

  async function pullRemote() {
    if (!cloudEnabled()) return;
    try {
      const { data, error } = await supabaseClient.from("revenue_projects").select("*");
      if (error) throw error;
      if (Array.isArray(data)) {
        // クラウドを正としてマージ（updated_at が新しい方を優先）
        const map = new Map(projects.map((p) => [p.id, p]));
        data.forEach((r) => {
          const remote = fromDbRow(r);
          const local = map.get(remote.id);
          if (!local || new Date(remote.updatedAt) >= new Date(local.updatedAt)) {
            map.set(remote.id, remote);
          }
        });
        projects = Array.from(map.values());
        saveProjectsLocal();
        renderAll();
      }
    } catch (e) {
      showToast("クラウド取得に失敗しました");
    }
  }

  async function upsertRemote(p) {
    if (!cloudEnabled()) return;
    try {
      const { error } = await supabaseClient.from("revenue_projects").upsert(toDbRow(p));
      if (error) throw error;
    } catch {
      /* オフライン時はローカルのみ。次回 syncLocal で送る */
    }
  }

  async function deleteRemote(id) {
    if (!cloudEnabled()) return;
    try {
      await supabaseClient.from("revenue_projects").delete().eq("id", id);
    } catch {
      /* noop */
    }
  }

  async function syncLocalToRemote() {
    if (!cloudEnabled()) {
      showToast("先にSupabase設定とログインを行ってください");
      return;
    }
    try {
      const rows = projects.map(toDbRow);
      const { error } = await supabaseClient.from("revenue_projects").upsert(rows);
      if (error) throw error;
      showToast(`${rows.length}件をクラウドへ同期しました`);
      await pullRemote();
    } catch {
      showToast("同期に失敗しました");
    }
  }

  function saveSupabaseSettings() {
    supaConfig.url = el.supabaseUrl.value.trim();
    supaConfig.anonKey = el.supabaseAnonKey.value.trim();
    supaConfig.email = el.loginEmail.value.trim();
    saveSupaConfigLocal();
    if (initSupabaseClient()) {
      showToast("Supabase設定を保存しました");
      refreshSession();
    } else {
      setCloudStatus("URL / キーを確認してください");
      showToast("Supabase設定を保存しましたが接続できません");
    }
  }

  async function sendLoginLink() {
    if (!supabaseClient) {
      showToast("先にSupabase設定を保存してください");
      return;
    }
    const email = (el.loginEmail.value || supaConfig.email || "").trim();
    if (!email) {
      showToast("ログイン用メールを入力してください");
      el.loginEmail.focus();
      return;
    }
    try {
      const { error } = await supabaseClient.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href },
      });
      if (error) throw error;
      supaConfig.email = email;
      saveSupaConfigLocal();
      showToast("ログインリンクを送信しました。メールを確認してください");
    } catch {
      showToast("ログインリンクの送信に失敗しました");
    }
  }

  async function logout() {
    if (!supabaseClient) return;
    try {
      await supabaseClient.auth.signOut();
      currentUser = null;
      setCloudStatus("ログアウトしました（ローカル保存のみ）");
      showToast("ログアウトしました");
    } catch {
      /* noop */
    }
  }

  function restoreCloudUI() {
    el.supabaseUrl.value = supaConfig.url || "";
    el.supabaseAnonKey.value = supaConfig.anonKey || "";
    el.loginEmail.value = supaConfig.email || "";
    if (supaConfig.url && supaConfig.anonKey) {
      if (initSupabaseClient()) {
        refreshSession();
        // 認証状態の変化を監視（マジックリンク帰還時など）
        supabaseClient.auth.onAuthStateChange((_event, session) => {
          currentUser = session?.user || null;
          if (currentUser) {
            setCloudStatus(`ログイン中: ${currentUser.email || ""}（クラウド同期ON）`);
            pullRemote();
          } else {
            setCloudStatus("Supabase設定済み: ログインするとクラウド同期します");
          }
        });
      } else {
        setCloudStatus("Supabase設定済み（接続待ち）");
      }
    } else {
      setCloudStatus("未設定: このブラウザ内に保存中");
    }
  }

  /* ---------------------------------------------------------------------
   * イベント
   * ------------------------------------------------------------------- */
  function bindEvents() {
    el.projectForm.addEventListener("submit", handleSubmit);
    el.cancelEditButton.addEventListener("click", resetForm);
    el.seedButton.addEventListener("click", seedSamples);

    el.goalInput.addEventListener("input", () => {
      monthlyGoal = Math.max(0, Math.round(Number(el.goalInput.value) || 0));
      saveGoalLocal();
      renderSummary();
      renderGoal();
    });

    // カード操作（イベント委譲）
    const boardClick = (e) => {
      const card = e.target.closest(".project-card");
      if (!card) return;
      const id = card.dataset.id;
      if (e.target.closest(".step-button")) stepStatus(id);
      else if (e.target.closest(".invoice-button")) openInvoice(id);
      else if (e.target.closest(".edit-button")) startEdit(id);
      else if (e.target.closest(".delete-button")) deleteProject(id);
    };
    el.activeList.addEventListener("click", boardClick);
    el.paidList.addEventListener("click", boardClick);

    el.csvButton.addEventListener("click", exportCsv);
    el.copyObsidianButton.addEventListener("click", copyMonthlySummary);

    // 請求書モーダル
    el.printInvoiceButton.addEventListener("click", () => window.print());
    el.closeInvoiceButton.addEventListener("click", closeInvoice);
    el.invoiceOverlay.addEventListener("click", (e) => {
      if (e.target === el.invoiceOverlay) closeInvoice();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.invoiceOverlay.hidden) closeInvoice();
    });
    el.invoiceOverlay.addEventListener("keydown", trapInvoiceFocus);

    // Supabase
    el.saveSupabaseButton.addEventListener("click", saveSupabaseSettings);
    el.loginButton.addEventListener("click", sendLoginLink);
    el.syncLocalButton.addEventListener("click", syncLocalToRemote);
    el.logoutButton.addEventListener("click", logout);
  }

  /* ---------------------------------------------------------------------
   * 起動
   * ------------------------------------------------------------------- */
  // PWA: Service Worker 登録
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(() => {
          /* オフライン時やローカルファイル開きの場合は無視 */
        });
    });
  }

  function init() {
    populateSelects();
    loadLocal();
    resetForm();
    bindEvents();
    restoreCloudUI();
    renderAll();
    registerSW();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
