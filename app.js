(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var D = window.APP_DATA;
  var STEPS = ["home", "consent", "info", "pre", "content", "wait", "post", "summary", "thanks", "ack"];
  var STORE_KEY = "sexed_state_v2";
  var WAIT_MS = (Number(CFG.WAIT_DAYS) > 0 ? Number(CFG.WAIT_DAYS) : 7) * 864e5;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ======================================================
     สถานะ (จำไว้ในเครื่อง เพื่อกลับมาทำต่อได้ แม้ปิดเบราว์เซอร์)
     ====================================================== */
  function freshState() {
    return {
      view: "home", max: 0, id: "", startedAt: "", info: {}, code: "", email: "",
      pre: {}, preCompleted: false, read: [], topic: 0,
      stage1Saved: false, contentDoneAt: "", unlockAt: "",
      post: {}, postSaved: false, finishedAt: "",
      thankIdx: null, sat: {}, satComment: "", satSaved: false, prevView: "home"
    };
  }
  function load() {
    try { var raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ใช้ในหน่วยความจำต่อไป */ }
  }
  function reset() {
    S = freshState();
    try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem("sexed_state_v1"); } catch (e) {}
  }
  var S = Object.assign(freshState(), load() || {});
  var repairedStage1 = false;
  // ซ่อมสถานะที่บันทึกครั้งที่ 1 ไม่สมบูรณ์ (เคยส่งไปยัง Code.gs เวอร์ชันเก่า จึงไม่ได้วันนัดกลับมา)
  if (S.stage1Saved && !S.postSaved && (!S.unlockAt || isNaN(new Date(S.unlockAt).getTime()))) {
    S.stage1Saved = false; S.unlockAt = "";
    if (!S.email) S.info.consent_final = false; // ต้องกรอกอีเมลใหม่
    if (S.view === "wait" || S.view === "post") S.view = S.email ? "content" : "info";
    repairedStage1 = true;
  }

  function idx(v) { return STEPS.indexOf(v); }
  function allTopicsRead() { return D.sections.every(function (s) { return S.read.indexOf(s.id) !== -1; }); }
  function unlocked() { return S.unlockAt && Date.now() >= new Date(S.unlockAt).getTime(); }
  function newId() {
    var a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", s = "";
    var buf = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint32Array(8)) : null;
    for (var i = 0; i < 8; i++) s += a[(buf ? buf[i] : Math.floor(Math.random() * 1e9)) % a.length];
    return "R-" + s;
  }

  /* ---------------- รหัสส่วนตัว ---------------- */
  function normCode(c) {
    return String(c || "").trim().toLowerCase().replace(/[๐-๙]/g, function (ch) { return String(ch.charCodeAt(0) - 0x0E50); });
  }
  function codeRules(c) {
    var raw = String(c || ""), s = normCode(c);
    return {
      len: s.length >= 6 && s.length <= 20,
      letter: /[a-zก-๎]/.test(s),
      digit: /[0-9]/.test(s),
      space: raw.trim() === raw ? !/\s/.test(raw) : false
    };
  }
  function codeOk(c) { var r = codeRules(c); return r.len && r.letter && r.digit && r.space; }

  /* ---------------- เวลาไทย ---------------- */
  var dtf = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  var THMONTH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  function parts(iso) { var d = new Date(iso), o = {}; if (isNaN(d)) return null; dtf.formatToParts(d).forEach(function (p) { o[p.type] = p.value; }); return o; }
  function fmtLong(iso) {
    var p = parts(iso); if (!p) return "—";
    return Number(p.day) + " " + THMONTH[Number(p.month) - 1] + " " + (Number(p.year) + 543) + " เวลา " + p.hour + ":" + p.minute + " น.";
  }

  /* ======================================================
     เชื่อมต่อ Google Apps Script
     ====================================================== */
  // เรียก Apps Script พร้อมลองส่งซ้ำอัตโนมัติเมื่อระบบช้า/ขัดข้องชั่วคราว (เช่น มีคนใช้พร้อมกันเยอะ)
  // ทุกคำสั่งออกแบบให้ส่งซ้ำได้ปลอดภัย (ระบบกันข้อมูลซ้ำด้วย response_id)
  var FINAL_ERRORS = ["code_taken", "weak_code", "bad_email", "not_found", "locked", "wrong_password", "no_password_set", "server_outdated", "unknown_action", "no_url", "bad_request"];
  var RETRY_DELAYS = [1200, 3000, 6000];
  function apiOnce(payload) {
    return fetch(CFG.SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw { code: "network", detail: "HTTP " + res.status };
      return res.json().catch(function () { throw { code: "server", detail: "bad json" }; });
    }, function () { throw { code: "network" }; }).then(function (j) {
      if (!j || j.ok !== true) throw { code: (j && j.error) || "server", data: j };
      return j;
    });
  }
  function api(payload) {
    if (!CFG.SCRIPT_URL) return Promise.reject({ code: "no_url" });
    var attempt = 0;
    var run = function () {
      return apiOnce(payload).catch(function (err) {
        var code = err && err.code;
        if (FINAL_ERRORS.indexOf(code) > -1 || attempt >= RETRY_DELAYS.length) throw err;
        var wait = RETRY_DELAYS[attempt++] + Math.floor(Math.random() * 800);
        return new Promise(function (r) { setTimeout(r, wait); }).then(run);
      });
    };
    return run();
  }
  var API_MSG = {
    network: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง",
    code_taken: "รหัสนี้มีคนใช้แล้ว กรุณาตั้งรหัสใหม่",
    weak_code: "รหัสต้องยาว 6–20 ตัว มีทั้งตัวอักษรและตัวเลข และไม่มีช่องว่าง",
    bad_email: "อีเมลไม่ถูกต้อง",
    not_found: "ไม่พบรหัสนี้ ตรวจสอบตัวสะกดอีกครั้ง",
    locked: "ยังไม่ครบ 7 วัน",
    server: "ระบบไม่ตอบกลับ อาจมีผู้ใช้งานพร้อมกันจำนวนมาก กรุณารอสักครู่แล้วลองอีกครั้ง",
    busy: "ขณะนี้มีผู้ใช้งานพร้อมกันจำนวนมาก กรุณารอสักครู่แล้วลองอีกครั้ง",
    server_outdated: "ระบบหลังบ้านยังเป็นเวอร์ชันเก่า (สำหรับผู้วิจัย: วาง Code.gs ใหม่แล้ว Deploy เป็น New version)",
    unknown_action: "ระบบหลังบ้านยังเป็นเวอร์ชันเก่า (สำหรับผู้วิจัย: วาง Code.gs ใหม่แล้ว Deploy เป็น New version)"
  };
  function apiMsg(e) { return API_MSG[e && e.code] || API_MSG.server; }

  /* ---------------- ค่าตั้งในหน้า ---------------- */
  $$("[data-cfg]").forEach(function (el) {
    var v = CFG[el.getAttribute("data-cfg")];
    if (Array.isArray(v)) el.innerHTML = '<ul class="cfg-list">' + v.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
    else el.textContent = v || "";
  });
  if (CFG.HERO_IMAGE) document.documentElement.style.setProperty("--hero-img", 'url("' + String(CFG.HERO_IMAGE).replace(/"/g, "") + '")');
  var hint = $(".scroll-hint");
  if (hint) hint.addEventListener("click", function (e) { e.preventDefault(); $("#homeMore").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $$("[data-cfg-wrap]").forEach(function (el) { el.hidden = !CFG[el.getAttribute("data-cfg-wrap")]; });
  $$("[data-mailto]").forEach(function (el) { if (el.textContent) el.href = "mailto:" + el.textContent; });
  $("#ackBody").innerHTML = D.acknowledgement.map(function (t) {
    return "<p>" + esc(t).replace("{ADVISOR}", esc(CFG.ADVISOR_NAME || "")) + "</p>";
  }).join("") + '<p class="ack-end">' + esc(D.acknowledgementEnd) + "</p>";
  (function renderCredits() {
    var T = CFG.TEAM || {};
    var html = '<h3>คณะผู้จัดทำ</h3>' +
      (T.members && T.members.length ? '<ul class="team">' + T.members.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" : "") +
      (T.advisor ? '<p><span class="muted">อาจารย์ที่ปรึกษา</span> ' + esc(T.advisor) + "</p>" : "") +
      (T.unit ? '<p class="muted">' + esc(T.unit) + "</p>" : "");
    $$("[data-credits]").forEach(function (el) { el.innerHTML = html; });
  })();

  /* ======================================================
     การนำทาง
     ====================================================== */
  // หาขั้นที่ควรอยู่จากสถานะปัจจุบัน
  function nextStep() {
    if (!S.id) return "consent";
    if (!S.info.consent_final) return "info";
    if (!S.preCompleted) return "pre";
    if (!S.stage1Saved) return "content";
    if (!S.postSaved) return unlocked() ? "post" : "wait";
    return S.view === "thanks" || S.view === "ack" ? S.view : "summary";
  }

  var waitTimer = null;
  function go(view, opts) {
    opts = opts || {};
    // ด่านตรวจลำดับ
    if (view === "pre" && S.preCompleted) view = "content";
    if (view === "post") {
      if (!S.stage1Saved) { toast(allTopicsRead() ? "กรุณากดบันทึกท้ายหน้าเนื้อหาก่อน" : "กรุณาอ่านเนื้อหาให้ครบทุกหัวข้อก่อน"); view = S.preCompleted ? "content" : nextStep(); }
      else if (S.postSaved) view = "summary";
      else if (!unlocked()) view = "wait";
    }
    if (view === "wait" && !S.stage1Saved) view = nextStep();
    if ((view === "summary" || view === "thanks" || view === "ack") && !S.postSaved) view = nextStep();
    if (["pre", "info"].indexOf(view) > -1 && !S.id) view = "consent";
    if (view === "pre" && !S.info.consent_final) view = "info";

    if (view !== "sources") S.prevView = view;
    S.view = view;
    if (idx(view) > S.max) S.max = idx(view);
    save();
    $$(".view").forEach(function (sec) { sec.hidden = sec.getAttribute("data-view") !== view; });
    document.body.classList.toggle("on-home", view === "home");
    clearInterval(waitTimer);
    renderView(view);
    updateNav();
    if (!opts.keepScroll) window.scrollTo(0, 0);
    if (!opts.noFocus) { var m = $("#main"); if (m) m.focus({ preventScroll: true }); }
  }

  function updateNav() {
    $$(".nav button").forEach(function (b) {
      var k = b.getAttribute("data-nav");
      b.disabled = false;
      var cur = (k === "home" && ["home", "consent", "info", "resume"].indexOf(S.view) > -1) ||
                (k === "assess" && ["pre", "wait", "post", "summary", "thanks", "ack"].indexOf(S.view) > -1) ||
                (k === "content" && S.view === "content") ||
                (k === "sources" && S.view === "sources");
      if (cur) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    var steps = [S.preCompleted, S.stage1Saved, S.postSaved, S.view === "thanks" || S.view === "ack"].filter(Boolean).length;
    $("#progressBar").style.width = (S.id ? 8 + steps * 23 : 0) + "%";
    var start = $("#btnStart");
    start.textContent = !S.id ? "เริ่มต้น" : S.postSaved ? "ดูผลของฉัน" : S.stage1Saved ? (unlocked() ? "ทำแบบประเมินหลังเรียน" : "ดูวันนัดของฉัน") : "ทำต่อจากเดิม";
    $("#btnReturn").hidden = !!S.id;
    $("#notMe").hidden = !S.id;
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-nav]");
    if (!t || t.disabled) return;
    var k = t.getAttribute("data-nav");
    if (k === "home") return go("home");
    if (k === "content") return go("content");
    if (k === "sources") return go("sources");
    if (k === "assess") return go(S.id ? nextStep() : "consent");
  });

  $("#btnStart").addEventListener("click", function () { go(S.id ? nextStep() : "consent"); });
  $("#btnReturn").addEventListener("click", function () { go("resume"); });
  // เครื่องที่ใช้ร่วมกัน: ล้างข้อมูลของคนก่อนหน้า (กด 2 ครั้งเพื่อยืนยัน)
  var notMeTimer = null;
  $("#btnNotMe").addEventListener("click", function () {
    var b = this;
    if (!b.dataset.confirm) {
      b.dataset.confirm = "1"; b.textContent = "กดอีกครั้งเพื่อยืนยันล้างข้อมูลในเครื่องนี้";
      clearTimeout(notMeTimer); notMeTimer = setTimeout(function () { delete b.dataset.confirm; b.textContent = "เริ่มใหม่ในเครื่องนี้"; }, 5000);
      return;
    }
    clearTimeout(notMeTimer); delete b.dataset.confirm; b.textContent = "เริ่มใหม่ในเครื่องนี้";
    reset(); $("#consentRead").checked = false; go("home");
    toast("ล้างข้อมูลในเครื่องนี้แล้ว คำตอบที่บันทึกไว้ในระบบยังอยู่ครบ");
  });

  /* ======================================================
     หน้ายินยอม
     ====================================================== */
  $("#consentRead").addEventListener("change", function () { $("#consentErr").hidden = true; });
  $("#btnAccept").addEventListener("click", function () {
    if (!$("#consentRead").checked) { $("#consentErr").hidden = false; $("#consentRead").focus(); return; }
    if (!S.id) { S.id = newId(); S.startedAt = new Date().toISOString(); }
    go("info");
  });
  $("#btnDecline").addEventListener("click", function () {
    reset();
    $("#consentRead").checked = false;
    go("home");
    toast("ขอบคุณที่สนใจ ท่านสามารถกลับมาเข้าร่วมได้ทุกเมื่อ");
  });

  /* ======================================================
     ข้อมูลทั่วไป + รหัสส่วนตัว + อีเมล
     ====================================================== */
  var INFO_FIELDS = [
    { name: "is_ubu", label: "ท่านเป็นนักศึกษามหาวิทยาลัยอุบลราชธานีหรือไม่", type: "chips", options: ["ใช่", "ไม่ใช่"] },
    { name: "gender", label: "เพศ", type: "chips", options: D.genders },
    { name: "year", label: "ชั้นปีการศึกษา", type: "chips", options: D.years },
    { name: "faculty", label: "คณะที่กำลังศึกษา", type: "select", options: D.faculties.concat(["อื่น ๆ (ไม่ใช่นักศึกษา ม.อุบลฯ)"]) },
    { name: "info_sources", label: "ท่านเคยได้รับข้อมูลเกี่ยวกับโรคติดต่อทางเพศสัมพันธ์จากแหล่งใดบ้าง (เลือกได้มากกว่า 1 ข้อ)", type: "multi", options: D.infoSources.concat([D.infoSourceNone]) },
    { name: "ever_sex", label: "ท่านเคยมีเพศสัมพันธ์หรือไม่", type: "chips", options: ["เคย", "ไม่เคย"] }
  ];

  function chipGroup(name, options, current) {
    return options.map(function (o) {
      var val = typeof o === "object" ? o.value : o;
      var lab = typeof o === "object" ? o.label : o;
      var cls = "chip" + (typeof o === "object" && o.cls ? " " + o.cls : "");
      return '<label class="' + cls + '"><input type="radio" name="' + name + '" value="' + esc(String(val)) + '"' +
        (String(current) === String(val) ? " checked" : "") + "><span>" + esc(lab) + "</span></label>";
    }).join("");
  }

  function renderInfo() {
    $("#infoFields").innerHTML = INFO_FIELDS.map(function (f) {
      var cur = S.info[f.name] || "";
      if (f.type === "select") {
        return '<div class="field" data-field="' + f.name + '"><label class="lbl" for="f_' + f.name + '">' + f.label + '<span class="req" aria-hidden="true">*</span></label>' +
          '<select id="f_' + f.name + '" name="' + f.name + '" required><option value="">— เลือกคณะ —</option>' +
          f.options.map(function (o) { return "<option" + (cur === o ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") +
          '</select><p class="field-error" hidden>กรุณาเลือกคณะ</p></div>';
      }
      if (f.type === "multi") {
        var sel = Array.isArray(cur) ? cur : [];
        return '<fieldset class="field" data-field="' + f.name + '"><legend>' + f.label + '<span class="req" aria-hidden="true">*</span></legend>' +
          '<div class="choices">' + f.options.map(function (o) {
            return '<label class="chip multi"><input type="checkbox" name="' + f.name + '" value="' + esc(o) + '"' + (sel.indexOf(o) > -1 ? " checked" : "") + "><span>" + esc(o) + "</span></label>";
          }).join("") + '</div><p class="field-error" hidden>กรุณาเลือกอย่างน้อย 1 ข้อ</p></fieldset>';
      }
      return '<fieldset class="field" data-field="' + f.name + '"><legend>' + f.label + '<span class="req" aria-hidden="true">*</span></legend>' +
        '<div class="choices">' + chipGroup(f.name, f.options, cur) + '</div><p class="field-error" hidden>กรุณาเลือกคำตอบ</p></fieldset>';
    }).join("");
    $("#f_code").value = S.code || "";
    $("#f_code2").value = S.code || "";
    $("#f_email").value = S.email || "";
    $("#consentFinal").checked = !!S.info.consent_final;
    updateRules();
  }

  function updateRules() {
    var r = codeRules($("#f_code").value), any = $("#f_code").value.length > 0;
    $$("#codeRules li").forEach(function (li) {
      var ok = r[li.getAttribute("data-rule")];
      li.className = any ? (ok ? "ok" : "no") : "";
    });
  }
  function fieldErr(name, msg) {
    var w = $('[data-field="' + name + '"]'); if (!w) return;
    var er = $(".field-error", w);
    if (msg) { w.classList.add("invalid"); er.textContent = msg; er.hidden = false; }
    else { w.classList.remove("invalid"); er.hidden = true; }
  }

  $("#infoForm").addEventListener("input", function (e) {
    if (e.target.id === "f_code") { updateRules(); fieldErr("code"); }
    if (e.target.id === "f_code2") fieldErr("code2");
    if (e.target.id === "f_email") fieldErr("email");
  });
  $("#infoForm").addEventListener("change", function (e) {
    var f = e.target.closest(".field");
    if (f && ["code", "code2", "email"].indexOf(f.getAttribute("data-field")) === -1) { f.classList.remove("invalid"); var er = $(".field-error", f); if (er) er.hidden = true; }
    if (e.target.name === "is_ubu" && e.target.value === "ไม่ใช่") {
      var sel = $("#f_faculty"); if (sel && !sel.value) { sel.value = "อื่น ๆ (ไม่ใช่นักศึกษา ม.อุบลฯ)"; S.info.faculty = sel.value; }
    }
    if (e.target.id === "consentFinal") $("#consentFinalErr").hidden = true;
    if (e.target.id === "f_email") { var v = e.target.value.trim(); if (v && !emailOk(v)) fieldErr("email", "กรุณากรอกอีเมลให้ถูกต้อง"); }
    if (e.target.name === "info_sources") {
      // "ไม่เคยได้รับข้อมูล" เลือกร่วมกับข้ออื่นไม่ได้
      var boxes = $$('input[name="info_sources"]');
      if (e.target.value === D.infoSourceNone && e.target.checked) boxes.forEach(function (b) { if (b !== e.target) b.checked = false; });
      else if (e.target.checked) boxes.forEach(function (b) { if (b.value === D.infoSourceNone) b.checked = false; });
      S.info.info_sources = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      save(); return;
    }
    if (e.target.name && ["code", "code2", "email"].indexOf(e.target.name) === -1) {
      S.info[e.target.name] = e.target.type === "checkbox" ? e.target.checked : e.target.value; save();
    }
  });
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  $("#infoForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target, bad = null, data = {};
    INFO_FIELDS.forEach(function (f) {
      var wrap = $('[data-field="' + f.name + '"]', form), v = "";
      if (f.type === "select") v = form.elements[f.name].value;
      else if (f.type === "multi") { v = $$('input[name="' + f.name + '"]:checked', form).map(function (b) { return b.value; }); if (!v.length) v = ""; }
      else { var c = $('input[name="' + f.name + '"]:checked', form); v = c ? c.value : ""; }
      if (!v) { wrap.classList.add("invalid"); $(".field-error", wrap).hidden = false; if (!bad) bad = wrap; }
      data[f.name] = v;
    });
    var code = $("#f_code").value, code2 = $("#f_code2").value, email = $("#f_email").value.trim();
    if (!codeOk(code)) { fieldErr("code", "รหัสยังไม่ครบเงื่อนไขด้านบน"); if (!bad) bad = $('[data-field="code"]'); }
    else if (normCode(code) !== normCode(code2)) { fieldErr("code2", "รหัสทั้งสองช่องไม่ตรงกัน"); if (!bad) bad = $('[data-field="code2"]'); }
    if (!emailOk(email)) { fieldErr("email", email ? "กรุณากรอกอีเมลให้ถูกต้อง" : "กรุณากรอกอีเมล"); if (!bad) bad = $('[data-field="email"]'); }
    if (!$("#consentFinal").checked) { $("#consentFinalErr").hidden = false; if (!bad) bad = $("#consentFinal"); }
    if (bad) return focusBad(bad);

    var btn = $('#infoForm button[type="submit"]');
    var proceed = function () {
      data.consent_final = true;
      S.info = data; S.code = code.trim(); S.email = email;
      go("pre");
    };
    if (!CFG.SCRIPT_URL) return proceed();
    btn.disabled = true; var old = btn.textContent; btn.textContent = "กำลังตรวจสอบรหัส…";
    api({ action: "check_code", code: code.trim() }).then(function (j) {
      // Code.gs เวอร์ชันเก่าจะตอบ {ok:true} โดยไม่มี available → อย่าเข้าใจผิดว่ารหัสซ้ำ
      if (typeof j.available !== "boolean") throw { code: "server_outdated" };
      if (!j.available) { fieldErr("code", API_MSG.code_taken); focusBad($('[data-field="code"]')); return; }
      proceed();
    }).catch(function (err) {
      if (err.code === "weak_code") { fieldErr("code", API_MSG.weak_code); focusBad($('[data-field="code"]')); }
      else toast(apiMsg(err));
    }).then(function () { btn.disabled = false; btn.textContent = old; });
  });

  function focusBad(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    var f = el.matches("input") ? el : $("input, select", el);
    if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, 250);
  }

  /* ======================================================
     แบบประเมิน (ก่อน/หลัง)
     ====================================================== */
  // คำถามคัดกรอง: ถ้าตอบ "ไม่มี" ข้อที่เกี่ยวกับเพศสัมพันธ์จะถูกซ่อนและบันทึกเป็น SKIP
  var SKIP = "SKIP";
  function screenNo(kind) { var sc = D[kind].screen; return !!sc && S[kind][sc.id] === sc.no; }
  function visibleItems(kind) { return D[kind].items.filter(function (it) { return !(it.sex && screenNo(kind)); }); }
  function applyScreen(kind) {
    var sc = D[kind].screen; if (!sc) return;
    var no = screenNo(kind);
    D[kind].items.forEach(function (it) {
      if (!it.sex) return;
      if (no) S[kind][it.id] = SKIP;
      else if (S[kind][it.id] === SKIP) delete S[kind][it.id];
    });
    save();
  }

  function renderAssess(kind) {
    var set = D[kind], answers = S[kind], form = $("#" + kind + "Form"), sc = set.screen;
    var step = kind === "pre" ? "ครั้งที่ 1" : "ครั้งที่ 2";
    var html = '<p class="eyebrow">' + step + " · " + set.title + "</p><h2>" + set.title + "</h2>";
    if (sc) {
      html += '<fieldset class="q screen" data-q="' + sc.id + '"><legend><span class="qn">ก่อนเริ่ม</span>' + esc(sc.text) + "</legend>" +
        '<div class="choices">' + chipGroup(sc.id, [sc.yes, sc.no], answers[sc.id] || "") + "</div>" +
        '<p class="field-error" hidden>กรุณาตอบคำถามนี้ก่อน</p></fieldset>';
    }
    html += '<div class="q-body" data-body' + (sc && !answers[sc.id] ? " hidden" : "") + '>' +
      '<p class="q-lead">' + set.lead + '</p><p class="muted">' + set.note + '</p><p class="skip-note" data-skipnote hidden>ข้อที่เกี่ยวกับการมีเพศสัมพันธ์ถูกข้ามให้แล้ว ตอบเฉพาะข้อที่เหลือ</p>';
    set.items.forEach(function (it, i) {
      html += '<fieldset class="q" data-q="' + it.id + '"' + (it.sex ? " data-sex" : "") + '><legend><span class="qn" data-qn>' + (i + 1) + ".</span>" + esc(it.text) + "</legend>" +
        '<div class="choices scale">' + chipGroup(it.id, D.scale, answers[it.id] === SKIP ? "" : (answers[it.id] || "")) + "</div>" +
        '<p class="field-error" hidden>กรุณาเลือกคำตอบข้อนี้</p></fieldset>';
    });
    html += '<p class="form-count" data-count></p></div><p class="field-error" data-submit-err hidden></p><div class="actions"><button class="btn btn-primary" type="submit">' +
      (kind === "pre" ? "บันทึกและไปอ่านเนื้อหา" : "บันทึกและดูผลของฉัน") + "</button></div>";
    form.innerHTML = html;
    refreshAssess(kind);
  }
  function refreshAssess(kind) {
    var form = $("#" + kind + "Form"), sc = D[kind].screen, no = screenNo(kind);
    var body = $("[data-body]", form); if (body) body.hidden = !!sc && !S[kind][sc.id];
    var note = $("[data-skipnote]", form); if (note) note.hidden = !no;
    var n = 0;
    D[kind].items.forEach(function (it) {
      var q = $('[data-q="' + it.id + '"]', form); if (!q) return;
      var hide = it.sex && no;
      q.hidden = hide;
      if (!hide) { n++; $("[data-qn]", q).textContent = n + "."; }
    });
    updateCount(kind);
  }
  function updateCount(kind) {
    var items = visibleItems(kind);
    var n = items.filter(function (it) { var v = S[kind][it.id]; return v != null && v !== "" && v !== SKIP; }).length;
    var el = $("#" + kind + "Form [data-count]");
    if (el) el.textContent = "ตอบแล้ว " + n + " จาก " + items.length + " ข้อ";
  }

  ["pre", "post"].forEach(function (kind) {
    var form = $("#" + kind + "Form");
    form.addEventListener("change", function (e) {
      if (!e.target.name) return;
      S[kind][e.target.name] = e.target.value; save();
      var q = e.target.closest(".q"); if (q) { q.classList.remove("invalid"); $(".field-error", q).hidden = true; }
      var sc = D[kind].screen;
      if (sc && e.target.name === sc.id) { applyScreen(kind); refreshAssess(kind); }
      else updateCount(kind);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var bad = null, sc = D[kind].screen;
      if (sc && !S[kind][sc.id]) {
        var sq = $('[data-q="' + sc.id + '"]', form);
        sq.classList.add("invalid"); $(".field-error", sq).hidden = false;
        return focusBad(sq);
      }
      applyScreen(kind);
      visibleItems(kind).forEach(function (it) {
        var v = S[kind][it.id];
        if (v == null || v === "" || v === SKIP) {
          var q = $('[data-q="' + it.id + '"]', form);
          q.classList.add("invalid"); $(".field-error", q).hidden = false;
          if (!bad) bad = q;
        }
      });
      if (bad) return focusBad(bad);
      if (kind === "pre") { S.preCompleted = true; save(); return go("content"); }
      submitStage2(form);
    });
  });

  /* ======================================================
     คะแนน
     ====================================================== */
  // คะแนนความเสี่ยง 0–4: ข้อป้องกัน = 4 − ความถี่, ข้อเสี่ยง = ความถี่ (คะแนนสูง = เสี่ยงมาก)
  function itemScore(it, raw) {
    if (raw === SKIP || raw === "NA" || raw == null || raw === "") return null;
    var v = Number(raw);
    if (isNaN(v)) return null;
    return it.dir === "-" ? v : D.scoreMax - v;
  }
  function calc(kind) {
    var scores = {}, sum = 0, n = 0;
    D[kind].items.forEach(function (it) {
      var s = itemScore(it, S[kind][it.id]);
      scores[it.id] = s;
      if (s != null) { sum += s; n++; }
    });
    var mean = n ? Math.round((sum / n) * 100) / 100 : null;
    return { scores: scores, mean: mean, n: n, total: sum, level: levelOf(mean) };
  }
  function levelOf(mean) {
    if (mean == null) return null;
    for (var i = 0; i < D.levels.length; i++) if (mean >= D.levels[i].min) return D.levels[i];
    return D.levels[D.levels.length - 1];
  }

  /* ======================================================
     เนื้อหา
     ====================================================== */
  function renderContent() {
    $("#tabs").innerHTML = D.sections.map(function (s, i) {
      var read = S.read.indexOf(s.id) > -1;
      return '<button type="button" class="tab" role="tab" id="tab-' + s.id + '" aria-controls="topic" aria-selected="' + (i === S.topic) + '" tabindex="' + (i === S.topic ? 0 : -1) + '" data-i="' + i + '">' +
        '<span aria-hidden="true">' + s.icon + "</span>" + esc(s.title) + (read ? '<span class="done" aria-label="อ่านแล้ว">✓</span>' : "") + "</button>";
    }).join("");
    showTopic(S.topic, false);
    renderExternal();
  }

  function updateContentFoot() {
    var nRead = S.read.length, total = D.sections.length, all = allTopicsRead(), btn = $("#btnToPost"), hint = $("#contentHint");
    $("#readCount").textContent = "อ่านแล้ว " + Math.min(nRead, total) + " / " + total + " หัวข้อ";
    if (!S.preCompleted) {
      btn.disabled = false; btn.textContent = S.id ? "ไปทำแบบประเมินก่อนเรียน" : "เริ่มทำแบบประเมิน";
      hint.textContent = "อ่านเนื้อหาได้ตลอด แต่การเข้าร่วมวิจัยต้องเริ่มจากแบบประเมินก่อนเรียน";
    } else if (S.postSaved) {
      btn.disabled = false; btn.textContent = "ดูผลของฉัน"; hint.textContent = "ท่านทำครบทั้ง 2 ครั้งแล้ว อ่านทบทวนได้ตลอด";
    } else if (S.stage1Saved) {
      btn.disabled = false; btn.textContent = unlocked() ? "ทำแบบประเมินหลังเรียน" : "ดูวันนัดของฉัน";
      hint.textContent = unlocked() ? "ครบ 7 วันแล้ว ทำแบบประเมินหลังเรียนได้เลย" : "อ่านทบทวนได้ระหว่างรอครบ 7 วัน";
    } else {
      btn.disabled = !all; btn.textContent = "อ่านครบแล้ว บันทึกและรับวันนัด";
      hint.textContent = all ? "อ่านครบแล้ว กดปุ่มด้านล่างเพื่อบันทึกและรับวันนัดทำแบบประเมินหลังเรียน" : "อ่านให้ครบทั้ง " + D.sections.length + " หัวข้อ แล้วกดปุ่มด้านล่างเพื่อบันทึกและรับวันนัดทำแบบประเมินหลังเรียน";
    }
  }

  function showTopic(i, focus) {
    var s = D.sections[i];
    S.topic = i;
    if (S.read.indexOf(s.id) === -1) S.read.push(s.id);
    save();
    $$(".tab").forEach(function (t, j) {
      t.setAttribute("aria-selected", j === i);
      t.tabIndex = j === i ? 0 : -1;
      if (D.sections[j] && S.read.indexOf(D.sections[j].id) > -1 && !$(".done", t)) t.insertAdjacentHTML("beforeend", '<span class="done" aria-label="อ่านแล้ว">✓</span>');
    });
    var v = (CFG.VIDEOS || {})[s.id];
    var video = v && v.id ? '<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(v.id) +
      '" title="' + esc(v.title || s.title) + '" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>' +
      (v.title ? '<p class="video-cap">วิดีโอ: ' + esc(v.title) + "</p>" : "") : "";
    var fig = s.infographic ? '<figure class="figure"><button type="button" data-zoom="' + s.infographic + '" aria-label="ขยายอินโฟกราฟิก">' +
      D.info[s.infographic] + '<span class="zoom" aria-hidden="true">แตะเพื่อขยาย</span></button><figcaption>อินโฟกราฟิก: ' + esc(s.title) + "</figcaption></figure>" : "";
    var prev = i > 0 ? '<button type="button" class="btn btn-ghost" data-topic="' + (i - 1) + '">← ' + esc(D.sections[i - 1].title) + "</button>" : "<span></span>";
    var next = i < D.sections.length - 1 ? '<button type="button" class="btn btn-primary" data-topic="' + (i + 1) + '">' + esc(D.sections[i + 1].title) + " →</button>" : "";
    var topic = $("#topic");
    topic.setAttribute("aria-labelledby", "tab-" + s.id);
    var photo = s.photo ? '<figure class="photo"><img src="' + s.photo.src + '" alt="' + esc(s.photo.alt) + '" loading="lazy"><figcaption>' + esc(s.photo.caption) + "</figcaption></figure>" : "";
    topic.innerHTML = '<h3><span aria-hidden="true">' + s.icon + "</span>" + esc(s.title) + "</h3>" + photo + s.html + fig + video + '<div class="topic-nav">' + prev + next + "</div>";
    updateContentFoot();
    if (focus) {
      var tab = $("#tab-" + s.id); if (tab) tab.scrollIntoView({ block: "nearest", inline: "center" });
      topic.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderExternal() {
    $("#externalMedia").innerHTML = '<h3>อินโฟกราฟิกและสื่อจากหน่วยงาน</h3><p class="muted">กดเพื่อเปิดดูจากเว็บไซต์ต้นทางในแท็บใหม่</p><div class="media-list">' +
      D.externalMedia.map(function (m) {
        return '<a class="media-item" href="' + m.url + '" target="_blank" rel="noopener"><span class="mi-icon" aria-hidden="true">📄</span>' +
          "<span><strong>" + esc(m.title) + "</strong><small>" + esc(m.source) + " · " + esc(m.note) + '</small></span><span class="ext" aria-hidden="true">↗</span></a>';
      }).join("") + "</div>";
  }

  $("#tabs").addEventListener("click", function (e) { var t = e.target.closest(".tab"); if (t) showTopic(Number(t.getAttribute("data-i")), true); });
  $("#tabs").addEventListener("keydown", function (e) {
    if (["ArrowRight", "ArrowLeft", "Home", "End"].indexOf(e.key) === -1) return;
    e.preventDefault();
    var n = D.sections.length, i = S.topic;
    if (e.key === "ArrowRight") i = (i + 1) % n;
    if (e.key === "ArrowLeft") i = (i - 1 + n) % n;
    if (e.key === "Home") i = 0;
    if (e.key === "End") i = n - 1;
    showTopic(i, false); $("#tab-" + D.sections[i].id).focus();
  });
  $("#topic").addEventListener("click", function (e) {
    var b = e.target.closest("[data-topic]"); if (b) return showTopic(Number(b.getAttribute("data-topic")), true);
    var z = e.target.closest("[data-zoom]"); if (z) openLightbox(D.info[z.getAttribute("data-zoom")]);
  });

  $("#btnToPost").addEventListener("click", function () {
    if (!S.preCompleted) return go(S.id ? nextStep() : "consent");
    if (S.stage1Saved) return go(nextStep());
    if (!allTopicsRead()) return toast("กรุณาอ่านเนื้อหาให้ครบทุกหัวข้อก่อน");
    submitStage1(this);
  });

  /* ---------------- บันทึกครั้งที่ 1 ---------------- */
  function stage1Payload() {
    var pre = calc("pre"), p = { action: "stage1", code: S.code, email: S.email };
    p.response_id = S.id;
    p.started_at = S.startedAt;
    p.content_read_at_client = new Date().toISOString();
    p.is_ubu_student = S.info.is_ubu;
    p.flag_non_ubu = S.info.is_ubu === "ไม่ใช่" ? "NON-UBU" : "";
    p.gender = S.info.gender; p.year = S.info.year; p.faculty = S.info.faculty;
    var srcs = S.info.info_sources || [];
    p.info_sources = srcs.join("; ");
    D.infoSources.concat([D.infoSourceNone]).forEach(function (o, i) { p["src" + (i + 1)] = srcs.indexOf(o) > -1 ? 1 : 0; });
    p.ever_sex = S.info.ever_sex;
    p.consent = "ยินยอม";
    p.pre_sex = S.pre[D.pre.screen.id] || "";
    D.pre.items.forEach(function (it) { p[it.id + "_raw"] = S.pre[it.id]; });
    D.pre.items.forEach(function (it) { p[it.id + "_score"] = pre.scores[it.id] == null ? "" : pre.scores[it.id]; });
    p.pre_n_answered = pre.n;
    p.pre_total = pre.n ? pre.total : "";
    p.pre_mean = pre.mean == null ? "" : pre.mean;
    p.pre_level = pre.level ? pre.level.label : "";
    p.content_topics_read = S.read.length;
    return p;
  }
  function submitStage1(btn) {
    var old = btn.textContent; btn.disabled = true; btn.textContent = "กำลังบันทึก…";
    var done = function (unlockAt) {
      S.stage1Saved = true; S.unlockAt = unlockAt; S.contentDoneAt = new Date().toISOString(); S.email = "";
      save(); go("wait");
    };
    if (!CFG.SCRIPT_URL) { done(new Date(Date.now() + WAIT_MS).toISOString()); return; }
    api(stage1Payload()).then(function (j) { if (!j.unlock_at) throw { code: "server_outdated" }; done(j.unlock_at); }).catch(function (err) {
      btn.disabled = false; btn.textContent = old;
      if (err.code === "code_taken" || err.code === "weak_code" || err.code === "bad_email") {
        toast(apiMsg(err)); S.info.consent_final = false; save(); go("info");
        setTimeout(function () { fieldErr(err.code === "bad_email" ? "email" : "code", apiMsg(err)); }, 50);
        return;
      }
      toast(apiMsg(err) + " แล้วกดปุ่มอีกครั้ง");
    });
  }

  /* ======================================================
     หน้ารอ 1 สัปดาห์
     ====================================================== */
  function renderWait() {
    var card = $("#waitCard");
    var draw = function () {
      var t = new Date(S.unlockAt).getTime();
      if (isNaN(t)) {
        card.innerHTML = '<h2>ยังไม่ได้รับวันนัดจากระบบ</h2><p>การบันทึกครั้งที่ 1 ยังไม่สมบูรณ์ กรุณากดบันทึกอีกครั้ง</p><div class="actions"><button class="btn btn-primary" type="button" id="btnRetry1">บันทึกอีกครั้ง</button></div>';
        $("#btnRetry1").addEventListener("click", function () { S.stage1Saved = false; if (!S.email) S.info.consent_final = false; save(); go(S.email ? "content" : "info"); });
        return;
      }
      var left = t - Date.now();
      if (left <= 0) {
        card.innerHTML = '<p class="eyebrow">ครั้งที่ 2</p><h2>ครบ 7 วันแล้ว</h2><p>ตอนนี้ท่านทำแบบประเมินพฤติกรรมหลังเรียนได้แล้ว ใช้เวลาประมาณ ' + esc(CFG.DURATION_POST_MIN || "5") + ' นาที</p>' +
          '<div class="actions"><button class="btn btn-ghost" type="button" data-nav="content">อ่านเนื้อหาอีกครั้ง</button><button class="btn btn-primary" type="button" id="btnGoPost">ทำแบบประเมินหลังเรียน</button></div>';
        $("#btnGoPost").addEventListener("click", function () { go("post"); });
        clearInterval(waitTimer);
        return;
      }
      var d = Math.floor(left / 864e5), h = Math.floor(left % 864e5 / 36e5), m = Math.max(0, Math.ceil(left % 36e5 / 6e4));
      if (m === 60) { m = 0; h++; }
      card.innerHTML =
        '<p class="eyebrow">บันทึกครั้งที่ 1 เรียบร้อย</p><h2>กลับมาทำแบบประเมินหลังเรียนอีกครั้ง</h2>' +
        '<p class="muted">ทำได้ตั้งแต่</p><p class="unlock-date">' + fmtLong(S.unlockAt) + "</p>" +
        '<div class="countdown" role="timer" aria-label="เหลือเวลาอีก ' + d + " วัน " + h + " ชั่วโมง " + m + ' นาที">' +
          "<div><strong>" + d + "</strong><span>วัน</span></div><div><strong>" + h + "</strong><span>ชั่วโมง</span></div><div><strong>" + m + "</strong><span>นาที</span></div></div>" +
        '<div class="code-remind"><div><span>รหัสส่วนตัวของท่าน</span><strong id="myCode" data-shown="0">••••••</strong></div><button type="button" class="btn btn-ghost btn-sm" id="btnShowCode">แสดงรหัส</button></div>' +
        '<ul class="wait-notes"><li>📧 ระบบจะส่งอีเมลเตือนเมื่อครบ 7 วัน (เช็กในกล่องจดหมายขยะด้วย)</li>' +
        "<li>🔑 กรุณาจดหรือแคปหน้าจอรหัสส่วนตัวเก็บไว้ ใช้กลับมาทำได้จากทุกเครื่อง</li>" +
        "<li>📖 ระหว่างรอ อ่านทบทวนเนื้อหาได้ตลอด</li></ul>" +
        '<div class="actions"><button class="btn btn-primary" type="button" data-nav="content">อ่านเนื้อหาอีกครั้ง</button></div>';
      var shown = false;
      $("#btnShowCode").addEventListener("click", function () {
        shown = !shown; $("#myCode").textContent = shown ? S.code : "••••••"; this.textContent = shown ? "ซ่อนรหัส" : "แสดงรหัส";
      });
    };
    draw();
    waitTimer = setInterval(function () { if (S.view === "wait") draw(); }, 30000);
  }

  /* ======================================================
     กลับมาทำต่อด้วยรหัสส่วนตัว
     ====================================================== */
  $("#btnResumeStart").addEventListener("click", function () { go(S.id ? nextStep() : "consent"); });
  $("#f_rcode").addEventListener("input", function () { $("#resumeErr").hidden = true; $('[data-field="rcode"]').classList.remove("invalid"); });
  $("#resumeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = $("#f_rcode").value, err = $("#resumeErr"), wrap = $('[data-field="rcode"]');
    var fail = function (msg) { err.textContent = msg; err.hidden = false; wrap.classList.add("invalid"); $("#f_rcode").focus(); };
    if (!code.trim()) return fail("กรุณาใส่รหัสส่วนตัว");
    if (!CFG.SCRIPT_URL) {
      if (S.code && normCode(S.code) === normCode(code)) return go(nextStep());
      return fail(API_MSG.not_found);
    }
    var btn = $("#btnResumeGo"); btn.disabled = true; btn.textContent = "กำลังค้นหา…";
    api({ action: "resume", code: code.trim() }).then(function (j) {
      var r = j.row; reset();
      S.id = r.response_id; S.startedAt = r.started_at; S.code = code.trim();
      S.info = { is_ubu: r.is_ubu_student, gender: r.gender, year: r.year, faculty: r.faculty, info_sources: String(r.info_sources || "").split("; ").filter(Boolean), ever_sex: r.ever_sex, consent_final: true };
      S.pre[D.pre.screen.id] = r.pre_sex || "";
      D.pre.items.forEach(function (it) { S.pre[it.id] = String(r[it.id + "_raw"]); });
      S.preCompleted = true; S.read = D.sections.map(function (s) { return s.id; });
      S.stage1Saved = true; S.unlockAt = j.unlock_at;
      if (r.status === "ทำครบ") {
        S.post[D.post.screen.id] = r.post_sex || "";
        D.post.items.forEach(function (it) { S.post[it.id] = String(r[it.id + "_raw"]); });
        S.postSaved = true; S.satSaved = !!r.satisfaction_at;
        S.thankIdx = Math.floor(Math.random() * D.thanks.length);
      }
      save(); go(nextStep());
    }).catch(function (er) { fail(apiMsg(er)); }).then(function () { btn.disabled = false; btn.textContent = "ไปต่อ"; });
  });

  /* ======================================================
     บันทึกครั้งที่ 2
     ====================================================== */
  function submitStage2(form) {
    var btn = $('button[type="submit"]', form), errEl = $("[data-submit-err]", form), old = btn.textContent;
    var pre = calc("pre"), post = calc("post");
    var diff = pre.mean != null && post.mean != null ? Math.round((post.mean - pre.mean) * 100) / 100 : "";
    var p = { action: "stage2", code: S.code, response_id: S.id, post_submitted_at_client: new Date().toISOString() };
    p.post_sex = S.post[D.post.screen.id] || "";
    D.post.items.forEach(function (it) { p[it.id + "_raw"] = S.post[it.id]; });
    D.post.items.forEach(function (it) { p[it.id + "_score"] = post.scores[it.id] == null ? "" : post.scores[it.id]; });
    p.post_n_answered = post.n;
    p.post_total = post.n ? post.total : "";
    p.post_mean = post.mean == null ? "" : post.mean;
    p.post_level = post.level ? post.level.label : "";
    p.score_diff = diff;
    p.pct_change = diff !== "" && pre.mean ? Math.round(diff / pre.mean * 1000) / 10 : "";
    var done = function () {
      S.postSaved = true; S.finishedAt = new Date().toISOString();
      if (S.thankIdx == null) S.thankIdx = Math.floor(Math.random() * D.thanks.length);
      save(); go("summary");
    };
    errEl.hidden = true;
    if (!CFG.SCRIPT_URL) return done();
    btn.disabled = true; btn.textContent = "กำลังบันทึก…";
    api(p).then(done).catch(function (err) {
      btn.disabled = false; btn.textContent = old;
      if (err.code === "locked") { S.unlockAt = err.data && err.data.unlock_at || S.unlockAt; save(); toast("ยังไม่ครบ 7 วัน"); return go("wait"); }
      errEl.textContent = "บันทึกไม่สำเร็จ: " + apiMsg(err) + " คำตอบของท่านยังอยู่ กดบันทึกอีกครั้งได้เลย";
      errEl.hidden = false;
    });
  }

  /* ======================================================
     สรุปผล
     ====================================================== */
  function renderSummary() {
    var pre = calc("pre"), post = calc("post"), max = D.scoreMax;
    function scoreBox(label, r, cls) {
      var badge = r.level ? '<span class="badge ' + r.level.key + '">' + r.level.label + "</span>" : '<span class="badge">ไม่มีข้อมูล</span>';
      return '<div class="score ' + cls + '"><div class="s-label">' + label + '</div><div class="s-num">' + (r.mean == null ? "—" : r.mean.toFixed(2)) + " <small>/ " + max + "</small></div>" + badge +
        '<div class="s-sub">' + (r.n ? "คะแนนรวม " + r.total + " จาก " + (r.n * max) + " (" + r.n + " ข้อ)" : "") + "</div></div>";
    }
    function bar(label, r, cls) {
      var w = r.mean == null ? 0 : (r.mean / max) * 100;
      return '<div class="bar-row"><span>' + label + '</span><div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + Math.max(w, 2) + '%"></div></div><span>' + (r.mean == null ? "—" : r.mean.toFixed(2)) + "</span></div>";
    }
    var notes = [];
    if (screenNo("pre")) notes.push("ก่อนเรียน: ท่านไม่ได้มีเพศสัมพันธ์ในช่วง 3 เดือนที่ผ่านมา คะแนนคิดจาก " + pre.n + " ข้อที่ไม่เกี่ยวกับเพศสัมพันธ์");
    if (screenNo("post")) notes.push("หลังเรียน: ท่านไม่ได้มีเพศสัมพันธ์ในช่วง 1 สัปดาห์ที่ผ่านมา คะแนนคิดจาก " + post.n + " ข้อที่ไม่เกี่ยวกับเพศสัมพันธ์");
    var change = "";
    if (pre.mean != null && post.mean != null) {
      var d = Math.round((post.mean - pre.mean) * 100) / 100;
      change = '<p class="change ' + (d < 0 ? "good" : d > 0 ? "bad" : "") + '">' +
        (d < 0 ? "▼ คะแนนความเสี่ยงลดลง " + Math.abs(d).toFixed(2) + " คะแนน" : d > 0 ? "▲ คะแนนความเสี่ยงเพิ่มขึ้น " + d.toFixed(2) + " คะแนน" : "● คะแนนความเสี่ยงเท่าเดิม") + "</p>";
    }
    var main = post.level || pre.level;
    $("#summaryCard").innerHTML =
      '<p class="eyebrow">สรุปผล</p><h2>ผลการประเมินพฤติกรรมเสี่ยงของคุณ</h2>' +
      '<p class="muted">คะแนนเฉลี่ย 0–' + max + ' <strong>คะแนนยิ่งสูง ยิ่งมีความเสี่ยงต่อการติดเชื้อซิฟิลิสมาก</strong></p>' +
      '<div class="score-grid">' + scoreBox("ก่อนเรียน (3 เดือนที่ผ่านมา)", pre, "before") + scoreBox("หลังเรียน (1 สัปดาห์ที่ผ่านมา)", post, "after") + "</div>" +
      notes.map(function (n) { return '<p class="note-temp">' + n + "</p>"; }).join("") +
      '<div class="bars">' + bar("ก่อนเรียน", pre, "before") + bar("หลังเรียน", post, "after") + "</div>" + change +
      (main ? '<div class="advice ' + main.key + '"><h4>' + main.label + "</h4><p>" + esc(main.message) + '</p><p class="tips-h">คำแนะนำ</p><ul>' +
        main.tips.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></div>" : "") +
      '<p class="disclaimer">' + esc(D.disclaimer) + "</p>" +
      '<p class="muted small">เกณฑ์: 0.00–1.33 ความเสี่ยงต่ำ · 1.34–2.67 ความเสี่ยงปานกลาง · 2.68–4.00 ความเสี่ยงสูง</p>' +
      '<div class="save-status ok">✓ บันทึกคำตอบทั้ง 2 ครั้งเรียบร้อยแล้ว</div>' +
      '<div class="actions"><button class="btn btn-ghost" type="button" data-nav="content">ทบทวนเนื้อหา</button><button class="btn btn-primary" type="button" id="btnToThanks">ไปต่อ</button></div>';
    $("#btnToThanks").addEventListener("click", function () { go("thanks"); });
  }

  /* ======================================================
     หน้าขอบคุณ + ความพึงพอใจ
     ====================================================== */
  function renderThanks() {
    if (S.thankIdx == null) { S.thankIdx = Math.floor(Math.random() * D.thanks.length); save(); }
    $("#thanksMsg").textContent = D.thanks[S.thankIdx];
    $("#satItems").innerHTML = D.satisfaction.map(function (q) {
      var cur = Number(S.sat[q.id] || 0);
      var stars = "";
      for (var v = 5; v >= 1; v--) {
        stars += '<input type="radio" id="' + q.id + "_" + v + '" name="' + q.id + '" value="' + v + '"' + (cur === v ? " checked" : "") + (S.satSaved ? " disabled" : "") + '>' +
          '<label for="' + q.id + "_" + v + '" title="' + D.starLabels[v] + '"><span class="sr">' + v + " ดาว " + D.starLabels[v] + "</span>★</label>";
      }
      return '<fieldset class="star-q"><legend>' + esc(q.text) + '</legend><div class="star-row"><div class="stars">' + stars + '</div><span class="star-val" data-for="' + q.id + '">' + (cur ? D.starLabels[cur] : "ยังไม่ให้คะแนน") + "</span>" +
        (S.satSaved ? "" : '<button type="button" class="link star-clear" data-clear="' + q.id + '"' + (cur ? "" : " hidden") + ">ล้าง</button>") + "</div></fieldset>";
    }).join("");
    var ta = $("#satComment"); ta.value = S.satComment || ""; ta.disabled = S.satSaved;
    $("#satCommentCount").textContent = ta.value.length;
    $("#btnSat").hidden = S.satSaved;
    var st = $("#satStatus");
    if (S.satSaved) { st.className = "sat-status ok"; st.textContent = "✓ ส่งความคิดเห็นแล้ว ขอบคุณมากครับ/ค่ะ"; }
    else { st.className = "sat-status"; st.textContent = ""; }
  }
  $("#satForm").addEventListener("change", function (e) {
    if (e.target.type !== "radio") return;
    S.sat[e.target.name] = Number(e.target.value); save();
    $('[data-for="' + e.target.name + '"]').textContent = D.starLabels[Number(e.target.value)];
    var c = $('[data-clear="' + e.target.name + '"]'); if (c) c.hidden = false;
  });
  $("#satForm").addEventListener("click", function (e) {
    var c = e.target.closest("[data-clear]"); if (!c) return;
    var k = c.getAttribute("data-clear"); delete S.sat[k]; save();
    $$('input[name="' + k + '"]').forEach(function (i) { i.checked = false; });
    $('[data-for="' + k + '"]').textContent = "ยังไม่ให้คะแนน"; c.hidden = true;
  });
  $("#satComment").addEventListener("input", function () { S.satComment = this.value; $("#satCommentCount").textContent = this.value.length; save(); });
  $("#satForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var any = Object.keys(S.sat).length || (S.satComment || "").trim();
    var st = $("#satStatus");
    if (!any) { st.className = "sat-status err"; st.textContent = "ยังไม่ได้ให้คะแนนหรือพิมพ์ข้อเสนอแนะ (ข้ามส่วนนี้ได้)"; return; }
    var p = { action: "satisfaction", code: S.code, response_id: S.id, sat_comment: (S.satComment || "").trim() };
    D.satisfaction.forEach(function (q) { p[q.id] = S.sat[q.id] || ""; });
    var done = function () { S.satSaved = true; save(); renderThanks(); toast("ขอบคุณสำหรับความคิดเห็น"); };
    if (!CFG.SCRIPT_URL) return done();
    var btn = $("#btnSat"); btn.disabled = true; btn.textContent = "กำลังส่ง…";
    api(p).then(done).catch(function (err) {
      st.className = "sat-status err"; st.textContent = "ส่งไม่สำเร็จ: " + apiMsg(err);
    }).then(function () { btn.disabled = false; btn.textContent = "ส่งความคิดเห็น"; });
  });

  $("#btnToAck").addEventListener("click", function () { go("ack"); });
  $("#btnRestart").addEventListener("click", function () {
    reset(); $("#consentRead").checked = false; go("home"); toast("ล้างข้อมูลในเครื่องนี้แล้ว พร้อมสำหรับผู้ตอบคนถัดไป");
  });

  /* ======================================================
     Lightbox / แหล่งข้อมูล / เครื่องมือ
     ====================================================== */
  var lb = $("#lightbox"), lastFocus = null;
  function openLightbox(svg) {
    lastFocus = document.activeElement; $("#lightboxBody").innerHTML = svg;
    if (lb.showModal) lb.showModal(); else lb.setAttribute("open", "");
    $("#lightboxClose").focus();
  }
  function closeLightbox() { if (lb.close) lb.close(); else lb.removeAttribute("open"); }
  lb.addEventListener("close", function () { if (lastFocus) lastFocus.focus(); });
  $("#lightboxClose").addEventListener("click", closeLightbox);
  lb.addEventListener("click", function (e) { if (e.target === lb) closeLightbox(); });

  function renderSources() {
    $("#refList").innerHTML = D.references.map(function (r) {
      return "<li>" + esc(r.text) + ' <a href="' + r.url + '" target="_blank" rel="noopener">' + esc(r.url) + "</a><small>ใช้ในหัวข้อ: " + esc(r.used) + "</small></li>";
    }).join("");
  }
  $("#btnSourcesBack").addEventListener("click", function () { go(S.prevView && S.prevView !== "sources" ? S.prevView : "home"); });

  function renderView(v) {
    if (v === "info") renderInfo();
    if (v === "pre") renderAssess("pre");
    if (v === "post") renderAssess("post");
    if (v === "content") renderContent();
    if (v === "wait") renderWait();
    if (v === "summary") renderSummary();
    if (v === "thanks") renderThanks();
    if (v === "sources") renderSources();
    if (v === "consent") $("#consentRead").checked = !!S.id;
    if (v === "resume") { $("#f_rcode").value = ""; $("#resumeErr").hidden = true; setTimeout(function () { $("#f_rcode").focus(); }, 50); }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  var toastTimer;
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3600);
  }

  /* ---------------- เริ่มต้น ---------------- */
  var startView = S.view || "home";
  go(startView, { noFocus: true });
  if (repairedStage1) toast("การบันทึกครั้งที่ 1 ยังไม่สมบูรณ์ กรุณายืนยันข้อมูลและกดบันทึกอีกครั้ง");
})();
