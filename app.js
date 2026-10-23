(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var D = window.APP_DATA;
  var STEPS = ["home", "consent", "info", "hlpre", "pre", "content", "skills", "wait", "hlpost", "post", "summary", "thanks", "ack"];
  var ASSESS = ["hlpre", "pre", "hlpost", "post"];
  var STORE_KEY = "sexed_state_v4";
  var LOCK = CFG.LOCK_POST === true; // ค่าเริ่มต้น = ปิดล็อก ทำแบบประเมินหลังเรียนได้ทันที
  var WAIT_DAYS = Number(CFG.WAIT_DAYS) > 0 ? Number(CFG.WAIT_DAYS) : 7;
  var WAIT_MS = LOCK ? WAIT_DAYS * 864e5 : 0;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ======================================================
     สถานะ (จำไว้ในเครื่อง เพื่อกลับมาทำต่อได้ แม้ปิดเบราว์เซอร์)
     ====================================================== */
  function freshState() {
    return {
      view: "home", max: 0, id: "", startedAt: "", info: {}, code: "", email: "",
      hlpre: {}, hlPreCompleted: false, pre: {}, preCompleted: false, read: [], topic: 0,
      skillRead: [], skillTopic: 0, skillQuiz: {},
      stage1Saved: false, contentDoneAt: "", unlockAt: "",
      hlpost: {}, hlPostCompleted: false, post: {}, postSaved: false, finishedAt: "",
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
    try { localStorage.removeItem(STORE_KEY); localStorage.removeItem("sexed_state_v2"); localStorage.removeItem("sexed_state_v3"); sessionStorage.removeItem("sexed_state_v1"); } catch (e) {}
  }
  var S = Object.assign(freshState(), load() || {});
  ["skillRead"].forEach(function (k) { if (!Array.isArray(S[k])) S[k] = []; });
  if (!S.skillQuiz || typeof S.skillQuiz !== "object") S.skillQuiz = {};
  var repairedStage1 = false;
  // ซ่อมสถานะที่บันทึกครั้งที่ 1 ไม่สมบูรณ์ (เคยส่งไปยัง Code.gs เวอร์ชันเก่า จึงไม่ได้วันนัดกลับมา)
  if (S.stage1Saved && !S.postSaved && (!S.unlockAt || isNaN(new Date(S.unlockAt).getTime()))) {
    S.stage1Saved = false; S.unlockAt = "";
    if (!S.email) S.info.consent_final = false; // ต้องกรอกอีเมลใหม่
    if (["wait", "hlpost", "post"].indexOf(S.view) > -1) S.view = S.email ? "content" : "info";
    repairedStage1 = true;
  }

  function idx(v) { return STEPS.indexOf(v); }
  function allTopicsRead() { return D.sections.every(function (s) { return S.read.indexOf(s.id) !== -1; }); }
  function skillDone(d) { return S.skillRead.indexOf(d.id) > -1 && d.quiz.every(function (q) { return S.skillQuiz[q.id] != null; }); }
  function allSkillsDone() { return D.hlDomains.every(skillDone); }
  function unlocked() { if (!LOCK) return !!S.stage1Saved; return S.unlockAt && Date.now() >= new Date(S.unlockAt).getTime(); }
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
    if (!S.hlPreCompleted) return "hlpre";
    if (!S.preCompleted) return "pre";
    if (!S.stage1Saved) return allTopicsRead() ? "skills" : "content";
    if (!S.postSaved) return !unlocked() ? "wait" : S.hlPostCompleted ? "post" : "hlpost";
    return S.view === "thanks" || S.view === "ack" ? S.view : "summary";
  }

  var waitTimer = null;
  function go(view, opts) {
    opts = opts || {};
    // ด่านตรวจลำดับ
    if (view === "hlpre" && S.hlPreCompleted) view = "pre";
    if (view === "pre" && S.preCompleted) view = "content";
    if (view === "hlpost" || view === "post") {
      if (!S.stage1Saved) { toast(!allTopicsRead() ? "กรุณาอ่านเนื้อหาให้ครบทุกหัวข้อก่อน" : allSkillsDone() ? "กรุณากดบันทึกท้ายหน้าความรอบรู้ 6 ด้านก่อน" : "กรุณาทำแบบฝึกทักษะให้ครบทั้ง 6 ด้านก่อน"); view = nextStep(); }
      else if (S.postSaved) view = "summary";
      else if (!unlocked()) view = "wait";
      else view = S.hlPostCompleted ? "post" : "hlpost";
    }
    if (view === "skills" && !S.preCompleted) view = nextStep();
    if (view === "skills" && !S.stage1Saved && !allTopicsRead()) { toast("กรุณาอ่านเนื้อหาให้ครบทั้ง " + D.sections.length + " หัวข้อก่อน"); view = "content"; }
    if (view === "wait" && !S.stage1Saved) view = nextStep();
    if ((view === "summary" || view === "thanks" || view === "ack") && !S.postSaved) view = nextStep();
    if (["hlpre", "pre", "info"].indexOf(view) > -1 && !S.id) view = "consent";
    if ((view === "hlpre" || view === "pre") && !S.info.consent_final) view = "info";
    if (view === "pre" && !S.hlPreCompleted) view = "hlpre";

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
                (k === "assess" && ["hlpre", "pre", "wait", "hlpost", "post", "summary", "thanks", "ack"].indexOf(S.view) > -1) ||
                (k === "content" && (S.view === "content" || S.view === "skills")) ||
                (k === "sources" && S.view === "sources");
      if (cur) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    var marks = [S.hlPreCompleted, S.preCompleted, S.stage1Saved, S.hlPostCompleted, S.postSaved, S.view === "thanks" || S.view === "ack"];
    var steps = marks.filter(Boolean).length;
    $("#progressBar").style.width = (S.id ? 8 + steps * 92 / marks.length : 0) + "%";
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
  var INFO_FIELDS = D.infoFields;
  function hasOther(f, v) { return !!f.other && (Array.isArray(v) ? v.indexOf(f.other) > -1 : v === f.other); }

  function chipGroup(name, options, current) {
    return options.map(function (o) {
      var val = typeof o === "object" ? o.value : o;
      var lab = typeof o === "object" ? o.label : o;
      var cls = "chip" + (typeof o === "object" && o.cls ? " " + o.cls : "");
      return '<label class="' + cls + '"><input type="radio" name="' + name + '" value="' + esc(String(val)) + '"' +
        (String(current) === String(val) ? " checked" : "") + "><span>" + esc(lab) + "</span></label>";
    }).join("");
  }

  var REQ = '<span class="req" aria-hidden="true">*</span>';
  // ช่องพิมพ์ "อื่น ๆ ระบุ" (แสดงเมื่อเลือกตัวเลือกนั้น) บันทึกเป็น <name>_other
  function otherBox(f, cur) {
    if (!f.other) return "";
    var id = "f_" + f.name + "_other";
    return '<div class="other-wrap" data-other-for="' + f.name + '"' + (hasOther(f, cur) ? "" : " hidden") + '><label class="lbl" for="' + id + '">โปรดระบุ' + REQ + "</label>" +
      '<input class="text-in" type="text" id="' + id + '" name="' + f.name + '_other" maxlength="100" value="' + esc(S.info[f.name + "_other"] || "") + '"></div>';
  }
  function renderInfo() {
    $("#infoFields").innerHTML = INFO_FIELDS.map(function (f) {
      var cur = S.info[f.name] || "";
      if (f.type === "number") {
        return '<div class="field" data-field="' + f.name + '"><label class="lbl" for="f_' + f.name + '">' + f.label + REQ + "</label>" +
          '<div class="num-row"><input class="text-in num-in" type="number" inputmode="numeric" step="1" min="' + f.min + '" max="' + f.max + '" id="f_' + f.name + '" name="' + f.name + '" value="' + esc(cur) + '"><span>' + esc(f.unit) + "</span></div>" +
          '<p class="field-error" hidden></p></div>';
      }
      if (f.type === "select") {
        return '<div class="field" data-field="' + f.name + '"><label class="lbl" for="f_' + f.name + '">' + f.label + REQ + "</label>" +
          '<select id="f_' + f.name + '" name="' + f.name + '" required><option value="">— เลือก —</option>' +
          f.options.map(function (o) { return "<option" + (cur === o ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") +
          "</select>" + otherBox(f, cur) + '<p class="field-error" hidden></p></div>';
      }
      if (f.type === "multi") {
        var sel = Array.isArray(cur) ? cur : [];
        return '<fieldset class="field" data-field="' + f.name + '"><legend>' + f.label + REQ + "</legend>" +
          '<div class="choices">' + f.options.map(function (o) {
            return '<label class="chip multi"><input type="checkbox" name="' + f.name + '" value="' + esc(o) + '"' + (sel.indexOf(o) > -1 ? " checked" : "") + "><span>" + esc(o) + "</span></label>";
          }).join("") + "</div>" + otherBox(f, sel) + '<p class="field-error" hidden></p></fieldset>';
      }
      return '<fieldset class="field" data-field="' + f.name + '"><legend>' + f.label + REQ + "</legend>" +
        '<div class="choices">' + chipGroup(f.name, f.options, cur) + "</div>" + otherBox(f, cur) + '<p class="field-error" hidden></p></fieldset>';
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
    // ช่องพิมพ์ (อายุ, อื่น ๆ ระบุ) จำไว้ระหว่างพิมพ์
    var tf = e.target.closest(".field");
    if (tf && (e.target.type === "number" || /_other$/.test(e.target.name))) { S.info[e.target.name] = e.target.value; save(); fieldErr(tf.getAttribute("data-field")); }
  });
  $("#infoForm").addEventListener("change", function (e) {
    var f = e.target.closest(".field");
    if (f && ["code", "code2", "email"].indexOf(f.getAttribute("data-field")) === -1) { f.classList.remove("invalid"); var er = $(".field-error", f); if (er) er.hidden = true; }
    if (e.target.id === "consentFinal") $("#consentFinalErr").hidden = true;
    if (e.target.id === "f_email") { var v = e.target.value.trim(); if (v && !emailOk(v)) fieldErr("email", "กรุณากรอกอีเมลให้ถูกต้อง"); }
    var fd = INFO_FIELDS.filter(function (x) { return x.name === e.target.name; })[0];
    if (fd && fd.type === "multi") {
      S.info[fd.name] = $$('input[name="' + fd.name + '"]').filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    } else if (e.target.name && ["code", "code2", "email"].indexOf(e.target.name) === -1) {
      S.info[e.target.name] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    }
    if (fd && fd.other) {
      var box = $('[data-other-for="' + fd.name + '"]'), show = hasOther(fd, S.info[fd.name]);
      if (box.hidden && show) setTimeout(function () { $("input", box).focus(); }, 0);
      box.hidden = !show;
    }
    save();
  });
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  $("#infoForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target, bad = null, data = {};
    INFO_FIELDS.forEach(function (f) {
      var wrap = $('[data-field="' + f.name + '"]', form), v = "", msg = "";
      if (f.type === "select" || f.type === "number") v = form.elements[f.name].value.trim();
      else if (f.type === "multi") { v = $$('input[name="' + f.name + '"]:checked', form).map(function (b) { return b.value; }); if (!v.length) v = ""; }
      else { var c = $('input[name="' + f.name + '"]:checked', form); v = c ? c.value : ""; }
      if (f.type === "number") {
        if (!v) msg = "กรุณากรอก" + f.label;
        else if (!/^\d+$/.test(v) || Number(v) < f.min || Number(v) > f.max) msg = "กรุณากรอก" + f.label + "เป็นตัวเลขจำนวนเต็ม " + f.min + "–" + f.max + " " + f.unit;
        else v = Number(v);
      } else if (!v) msg = f.type === "multi" ? "กรุณาเลือกอย่างน้อย 1 ข้อ" : "กรุณาเลือกคำตอบ";
      data[f.name] = v;
      if (f.other) {
        var ot = hasOther(f, v) ? form.elements[f.name + "_other"].value.trim() : "";
        if (hasOther(f, v) && !ot && !msg) msg = "กรุณาระบุ “" + f.other + "”";
        data[f.name + "_other"] = ot;
      }
      if (msg) { fieldErr(f.name, msg); if (!bad) bad = wrap; }
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
      go("hlpre");
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
  // ลำดับแบบประเมิน: ครั้งละ 2 ชุด (ความรอบรู้ → พฤติกรรม) ทุกข้อบังคับตอบ
  var ASSESS_META = {
    hlpre: { step: "ขั้นที่ 3 · ครั้งที่ 1 · ชุดที่ 1 จาก 2", btn: "บันทึกและไปชุดที่ 2" },
    pre: { step: "ขั้นที่ 4 · ครั้งที่ 1 · ชุดที่ 2 จาก 2", btn: "บันทึกและไปอ่านเนื้อหา" },
    hlpost: { step: "ขั้นที่ 2 · ครั้งที่ 2 · ชุดที่ 1 จาก 2", btn: "บันทึกและไปชุดที่ 2" },
    post: { step: "ขั้นที่ 3 · ครั้งที่ 2 · ชุดที่ 2 จาก 2", btn: "บันทึกและดูผลของฉัน" }
  };
  function answered(v) { return v != null && v !== ""; }
  function renderAssess(kind) {
    var set = D[kind], answers = S[kind], form = $("#" + kind + "Form");
    var html = '<p class="eyebrow">' + ASSESS_META[kind].step + "</p><h2>" + esc(set.title) + "</h2>" +
      (set.subtitle ? '<p class="q-sub">' + esc(set.subtitle) + "</p>" : "") +
      '<div class="q-guide"><p><strong>คำชี้แจง</strong> ' + esc(set.lead) + "</p>" +
      (set.legend ? '<ul class="scale-legend">' + set.legend.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" : "") + "</div>";
    set.items.forEach(function (it, i) {
      html += '<fieldset class="q" data-q="' + it.id + '"><legend><span class="qn">' + (i + 1) + ".</span>" + esc(it.text) + "</legend>" +
        '<div class="choices scale">' + chipGroup(it.id, set.scale || D.scale, answers[it.id] || "") + "</div>" +
        '<p class="field-error" hidden>กรุณาเลือกคำตอบข้อนี้</p></fieldset>';
    });
    html += '<p class="form-count" data-count></p><p class="field-error" data-submit-err hidden></p><div class="actions"><button class="btn btn-primary" type="submit">' +
      ASSESS_META[kind].btn + "</button></div>";
    form.innerHTML = html;
    updateCount(kind);
  }
  function updateCount(kind) {
    var items = D[kind].items;
    var n = items.filter(function (it) { return answered(S[kind][it.id]); }).length;
    var el = $("#" + kind + "Form [data-count]");
    if (el) el.textContent = "ตอบแล้ว " + n + " จาก " + items.length + " ข้อ";
  }

  ASSESS.forEach(function (kind) {
    var form = $("#" + kind + "Form");
    form.addEventListener("change", function (e) {
      if (!e.target.name) return;
      S[kind][e.target.name] = e.target.value; save();
      var q = e.target.closest(".q"); if (q) { q.classList.remove("invalid"); $(".field-error", q).hidden = true; }
      updateCount(kind);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var bad = null;
      D[kind].items.forEach(function (it) {
        if (answered(S[kind][it.id])) return;
        var q = $('[data-q="' + it.id + '"]', form);
        q.classList.add("invalid"); $(".field-error", q).hidden = false;
        if (!bad) bad = q;
      });
      if (bad) return focusBad(bad);
      if (kind === "hlpre") { S.hlPreCompleted = true; save(); return go("pre"); }
      if (kind === "pre") { S.preCompleted = true; save(); return go("content"); }
      if (kind === "hlpost") { S.hlPostCompleted = true; save(); return go("post"); }
      submitStage2(form);
    });
  });

  /* ======================================================
     คะแนน
     ====================================================== */
  // พฤติกรรม: คะแนนความเสี่ยง 0–4 ข้อป้องกัน = 4 − ความถี่, ข้อเสี่ยง = ความถี่ (คะแนนสูง = เสี่ยงมาก)
  // ความรอบรู้: คะแนน 1–5 ข้อทางบวก = คำตอบ, ข้อทางลบ (rev) = 6 − คำตอบ (คะแนนสูง = รอบรู้มาก)
  function itemScore(set, it, raw) {
    if (raw == null || raw === "") return null;
    var v = Number(raw);
    if (isNaN(v)) return null;
    if (set.hl) return it.rev ? set.scoreMax + 1 - v : v;
    return it.dir === "-" ? v : D.scoreMax - v;
  }
  function calc(kind) {
    var set = D[kind], scores = {}, sum = 0, n = 0;
    set.items.forEach(function (it) {
      var s = itemScore(set, it, S[kind][it.id]);
      scores[it.id] = s;
      if (s != null) { sum += s; n++; }
    });
    var mean = n ? Math.round((sum / n) * 100) / 100 : null;
    return { scores: scores, mean: mean, n: n, total: sum, level: levelOf(mean, set.levels) };
  }
  function levelOf(mean, levels) {
    levels = levels || D.levels;
    if (mean == null) return null;
    for (var i = 0; i < levels.length; i++) if (mean >= levels[i].min) return levels[i];
    return levels[levels.length - 1];
  }
  // ใส่คำตอบดิบ คะแนนรายข้อ และคะแนนสรุปของแบบประเมินหนึ่งชุดลงใน payload
  // prefix: "pre" → pre_total … / "hl_pre" → hl_pre_total …
  function addScores(p, kind, prefix) {
    var set = D[kind], r = calc(kind);
    set.items.forEach(function (it) { p[it.id + "_raw"] = S[kind][it.id]; });
    set.items.forEach(function (it) { p[it.id + "_score"] = r.scores[it.id] == null ? "" : r.scores[it.id]; });
    p[prefix + "_n_answered"] = r.n;
    p[prefix + "_total"] = r.n ? r.total : "";
    p[prefix + "_mean"] = r.mean == null ? "" : r.mean;
    p[prefix + "_level"] = r.level ? r.level.label : "";
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
      hint.textContent = unlocked() ? (LOCK ? "ครบ 7 วันแล้ว ทำแบบประเมินหลังเรียนได้เลย" : "ทำแบบประเมินหลังเรียนได้เลย") : "อ่านทบทวนได้ระหว่างรอครบ 7 วัน";
    } else {
      btn.disabled = !all; btn.textContent = "อ่านครบแล้ว ไปเนื้อหาความรอบรู้ 6 ด้าน";
      hint.textContent = all ? "อ่านครบแล้ว กดปุ่มด้านล่างเพื่อไปศึกษาเนื้อหาและทำแบบฝึกทักษะความรอบรู้ด้านสุขภาพ 6 ด้าน" : "อ่านให้ครบทั้ง " + D.sections.length + " หัวข้อ แล้วกดปุ่มด้านล่างเพื่อไปเนื้อหาความรอบรู้ด้านสุขภาพ 6 ด้าน";
    }
    $("#btnToSkills").hidden = !(S.preCompleted && (all || S.stage1Saved));
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
    go("skills");
  });
  $("#btnToSkills").addEventListener("click", function () { go("skills"); });

  /* ======================================================
     เสริมสร้างความรอบรู้ด้านสุขภาพ 6 ด้าน + แบบฝึกทักษะ
     ====================================================== */
  function renderSkills() {
    if (S.skillTopic >= D.hlDomains.length) S.skillTopic = 0;
    $("#skillTabs").innerHTML = D.hlDomains.map(function (d, i) {
      return '<button type="button" class="tab" role="tab" id="stab-' + d.id + '" aria-controls="skill" aria-selected="' + (i === S.skillTopic) + '" tabindex="' + (i === S.skillTopic ? 0 : -1) + '" data-i="' + i + '">' +
        '<span aria-hidden="true">' + d.icon + "</span>ด้านที่ " + d.n + " " + esc(d.title) + (skillDone(d) ? '<span class="done" aria-label="ทำครบแล้ว">✓</span>' : "") + "</button>";
    }).join("");
    showSkill(S.skillTopic, false);
  }

  function quizCard(q, i) {
    var ans = S.skillQuiz[q.id], answered = ans != null, letters = "ABCDEFGH";
    var opts = q.options.map(function (o, j) {
      var cls = "q-opt" + (answered && j === q.answer ? " is-right" : "") + (answered && j === ans && j !== q.answer ? " is-wrong" : "") + (answered && j === ans ? " is-picked" : "");
      return '<li><button type="button" class="' + cls + '" data-q="' + q.id + '" data-o="' + j + '"' + (answered ? ' disabled aria-pressed="' + (j === ans) + '"' : "") + ">" +
        '<span class="q-letter" aria-hidden="true">' + letters[j] + "</span><span>" + esc(o) + "</span></button></li>";
    }).join("");
    var fb = answered ? '<div class="q-feedback ' + (ans === q.answer ? "ok" : "no") + '" role="status"><strong>' + (ans === q.answer ? "✓ ถูกต้อง!" : "ยังไม่ใช่") + " · เฉลย: ข้อ " + letters[q.answer] + "</strong><p>" + esc(q.explain) + "</p></div>" : "";
    return '<div class="q-card"><div class="q-head"><span class="q-num">ข้อ ' + (i + 1) + "</span><h5>" + esc(q.title) + "</h5></div>" +
      (q.quote ? '<div class="q-post" aria-hidden="true">' + esc(q.quote) + "</div>" : "") +
      '<p class="q-label">สถานการณ์จำลอง</p><p>' + esc(q.scenario) + "</p>" +
      '<p class="q-label">คำถาม</p><p class="q-text">' + esc(q.q) + "</p>" +
      '<ol class="q-opts">' + opts + "</ol>" + fb + "</div>";
  }

  function showSkill(i, focus) {
    var d = D.hlDomains[i];
    S.skillTopic = i;
    if (S.skillRead.indexOf(d.id) === -1) S.skillRead.push(d.id);
    save();
    $$("#skillTabs .tab").forEach(function (t, j) { t.setAttribute("aria-selected", j === i); t.tabIndex = j === i ? 0 : -1; });
    var prev = i > 0 ? '<button type="button" class="btn btn-ghost" data-skill="' + (i - 1) + '">← ด้านที่ ' + D.hlDomains[i - 1].n + "</button>" : "<span></span>";
    var next = i < D.hlDomains.length - 1 ? '<button type="button" class="btn btn-primary" data-skill="' + (i + 1) + '">ด้านที่ ' + D.hlDomains[i + 1].n + " " + esc(D.hlDomains[i + 1].title) + " →</button>" : "";
    var el = $("#skill");
    el.className = "card topic skill theme-" + d.theme;
    el.setAttribute("aria-labelledby", "stab-" + d.id);
    el.innerHTML =
      '<div class="skill-hero"><p class="skill-n">ด้านที่ ' + d.n + " จาก " + D.hlDomains.length + " · " + esc(d.en) + "</p>" +
      '<h3><span aria-hidden="true">' + d.icon + "</span>" + esc(d.title) + "</h3>" +
      '<div class="skill-goal"><strong>🎯 เป้าหมาย</strong><p>' + esc(d.goal) + "</p></div></div>" +
      d.html +
      '<div class="q-section"><h4 class="q-title">สถานการณ์จำลอง + แบบฝึกทักษะ</h4><p class="muted">อ่านสถานการณ์ แล้วเลือกคำตอบที่ถูกต้องที่สุด (ตอบได้ครั้งเดียว ระบบจะแสดงเฉลยทันที)</p>' +
      '<div class="q-grid">' + d.quiz.map(quizCard).join("") + "</div></div>" +
      '<div class="remember"><strong>💡 จำไว้เสมอ!</strong><ul>' + d.remember.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div>" +
      '<div class="topic-nav">' + prev + next + "</div>";
    updateSkillsFoot();
    if (focus) {
      var tab = $("#stab-" + d.id); if (tab) tab.scrollIntoView({ block: "nearest", inline: "center" });
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function updateSkillsFoot() {
    var n = D.hlDomains.filter(skillDone).length, total = D.hlDomains.length, btn = $("#btnSkillsDone"), hint = $("#skillsHint");
    $("#skillCount").textContent = "ทำครบแล้ว " + n + " / " + total + " ด้าน";
    $$("#skillTabs .tab").forEach(function (t, j) {
      if (skillDone(D.hlDomains[j]) && !$(".done", t)) t.insertAdjacentHTML("beforeend", '<span class="done" aria-label="ทำครบแล้ว">✓</span>');
    });
    if (S.postSaved) { btn.disabled = false; btn.textContent = "ดูผลของฉัน"; hint.textContent = "ท่านทำครบทั้ง 2 ครั้งแล้ว ทบทวนได้ตลอด"; }
    else if (S.stage1Saved) {
      btn.disabled = false; btn.textContent = unlocked() ? "ทำแบบประเมินหลังเรียน" : "ดูวันนัดของฉัน";
      hint.textContent = unlocked() ? (LOCK ? "ครบ 7 วันแล้ว ทำแบบประเมินหลังเรียนได้เลย" : "ทำแบบประเมินหลังเรียนได้เลย") : "ทบทวนได้ระหว่างรอครบ 7 วัน";
    } else {
      btn.disabled = n < total; btn.textContent = "ทำครบแล้ว บันทึกและรับวันนัด";
      hint.textContent = n < total ? "ศึกษาเนื้อหาและทำแบบฝึกทักษะให้ครบทั้ง " + total + " ด้าน แล้วกดปุ่มด้านล่างเพื่อบันทึกและรับวันนัดทำแบบประเมินหลังเรียน" : "ทำครบทั้ง " + total + " ด้านแล้ว กดปุ่มด้านล่างเพื่อบันทึกและรับวันนัดทำแบบประเมินหลังเรียน";
    }
  }

  $("#skillTabs").addEventListener("click", function (e) { var t = e.target.closest(".tab"); if (t) showSkill(Number(t.getAttribute("data-i")), true); });
  $("#skillTabs").addEventListener("keydown", function (e) {
    if (["ArrowRight", "ArrowLeft", "Home", "End"].indexOf(e.key) === -1) return;
    e.preventDefault();
    var n = D.hlDomains.length, i = S.skillTopic;
    if (e.key === "ArrowRight") i = (i + 1) % n;
    if (e.key === "ArrowLeft") i = (i - 1 + n) % n;
    if (e.key === "Home") i = 0;
    if (e.key === "End") i = n - 1;
    showSkill(i, false); $("#stab-" + D.hlDomains[i].id).focus();
  });
  $("#skill").addEventListener("click", function (e) {
    var b = e.target.closest("[data-skill]"); if (b) return showSkill(Number(b.getAttribute("data-skill")), true);
    var o = e.target.closest("[data-o]");
    if (!o || o.disabled) return;
    var qid = o.getAttribute("data-q");
    if (S.skillQuiz[qid] != null) return;
    S.skillQuiz[qid] = Number(o.getAttribute("data-o")); save();
    var card = o.closest(".q-card"), d = D.hlDomains[S.skillTopic];
    var qi = d.quiz.map(function (q) { return q.id; }).indexOf(qid);
    card.outerHTML = quizCard(d.quiz[qi], qi);
    updateSkillsFoot();
  });

  $("#btnSkillsDone").addEventListener("click", function () {
    if (!S.preCompleted) return go(nextStep());
    if (S.stage1Saved) return go(nextStep());
    if (!allSkillsDone()) return toast("กรุณาทำแบบฝึกทักษะให้ครบทั้ง 6 ด้านก่อน");
    submitStage1(this);
  });

  /* ---------------- บันทึกครั้งที่ 1 ---------------- */
  function stage1Payload() {
    var p = { action: "stage1", code: S.code, email: S.email };
    p.response_id = S.id;
    p.started_at = S.startedAt;
    p.content_read_at_client = new Date().toISOString();
    // ข้อมูลส่วนบุคคล: 1 คอลัมน์ต่อฟิลด์ + <name>_other สำหรับ "อื่น ๆ ระบุ"
    INFO_FIELDS.forEach(function (f) {
      var v = S.info[f.name];
      if (f.type === "multi") {
        v = Array.isArray(v) ? v : [];
        p[f.name] = v.join("; ");
        f.options.forEach(function (o, i) { p["src" + (i + 1)] = v.indexOf(o) > -1 ? 1 : 0; }); // src1 … = 1/0 รายตัวเลือก
      } else p[f.name] = v == null ? "" : v;
      if (f.other) p[f.name + "_other"] = S.info[f.name + "_other"] || "";
    });
    p.consent = "ยินยอม";
    addScores(p, "hlpre", "hl_pre"); // ชุดที่ 1 ความรอบรู้ (คอลัมน์ hl_pre…)
    addScores(p, "pre", "pre"); // ชุดที่ 2 พฤติกรรม (คอลัมน์ pre…)
    p.content_topics_read = S.read.length;
    // แบบฝึกทักษะความรอบรู้ 6 ด้าน (ฝึกทำ ไม่ใช่แบบประเมิน): จำนวนด้านที่ทำครบ และจำนวนข้อที่ตอบถูกครั้งแรก
    var qs = [].concat.apply([], D.hlDomains.map(function (d) { return d.quiz; }));
    p.skills_domains_done = D.hlDomains.filter(skillDone).length;
    p.skills_quiz_correct = qs.filter(function (q) { return S.skillQuiz[q.id] === q.answer; }).length;
    p.skills_quiz_total = qs.length;
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
      if (!LOCK) {
        card.innerHTML = '<p class="eyebrow">บันทึกครั้งที่ 1 เรียบร้อย</p><h2>ทำแบบประเมินหลังเรียนได้เลย</h2><p>ท่านทำแบบประเมินหลังเข้าร่วมโปรแกรมได้ทันที 2 ชุด คือ แบบประเมินความรอบรู้ด้านสุขภาพ ' + D.hlpost.items.length + ' ข้อ และแบบประเมินพฤติกรรม ' + D.post.items.length + ' ข้อ ใช้เวลาประมาณ ' + esc(CFG.DURATION_POST_MIN || "15") + ' นาที</p>' +
          '<div class="code-remind"><div><span>รหัสส่วนตัวของท่าน</span><strong id="myCode" data-shown="0">••••••</strong></div><button type="button" class="btn btn-ghost btn-sm" id="btnShowCode">แสดงรหัส</button></div>' +
          '<ul class="wait-notes"><li>🔑 ถ้าจะกลับมาทำภายหลัง กด "กลับมาทำแบบประเมินหลังเรียน" ที่หน้าแรก แล้วใส่รหัสส่วนตัว ใช้ได้จากทุกเครื่อง</li>' +
          '<li>📧 ระบบจะส่งอีเมลเตือนเมื่อครบ ' + WAIT_DAYS + ' วัน หากท่านยังไม่ได้ทำ</li></ul>' +
          '<div class="actions"><button class="btn btn-ghost" type="button" data-nav="content">อ่านเนื้อหาอีกครั้ง</button><button class="btn btn-primary" type="button" id="btnGoPost">ทำแบบประเมินหลังเรียน</button></div>';
        $("#btnGoPost").addEventListener("click", function () { go("hlpost"); });
        var shown0 = false;
        $("#btnShowCode").addEventListener("click", function () {
          shown0 = !shown0; $("#myCode").textContent = shown0 ? S.code : "••••••"; this.textContent = shown0 ? "ซ่อนรหัส" : "แสดงรหัส";
        });
        clearInterval(waitTimer);
        return;
      }
      var left = t - Date.now();
      if (left <= 0) {
        card.innerHTML = '<p class="eyebrow">ครั้งที่ 2</p><h2>ครบ 7 วันแล้ว</h2><p>ตอนนี้ท่านทำแบบประเมินหลังเข้าร่วมโปรแกรมได้แล้ว 2 ชุด คือ แบบประเมินความรอบรู้ด้านสุขภาพ ' + D.hlpost.items.length + ' ข้อ และแบบประเมินพฤติกรรม ' + D.post.items.length + ' ข้อ ใช้เวลาประมาณ ' + esc(CFG.DURATION_POST_MIN || "15") + ' นาที</p>' +
          '<div class="actions"><button class="btn btn-ghost" type="button" data-nav="content">อ่านเนื้อหาอีกครั้ง</button><button class="btn btn-primary" type="button" id="btnGoPost">ทำแบบประเมินหลังเรียน</button></div>';
        $("#btnGoPost").addEventListener("click", function () { go("hlpost"); });
        clearInterval(waitTimer);
        return;
      }
      card.innerHTML =
        '<p class="eyebrow">บันทึกครั้งที่ 1 เรียบร้อย</p><h2>กลับมาทำแบบประเมินหลังเรียนอีกครั้ง</h2>' +
        '<p class="muted">ทำได้ตั้งแต่</p><p class="unlock-date">' + fmtLong(S.unlockAt) + "</p>" +
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
      S.info = { consent_final: true };
      INFO_FIELDS.forEach(function (f) {
        var v = r[f.name] == null ? "" : r[f.name];
        S.info[f.name] = f.type === "multi" ? String(v).split("; ").filter(Boolean) : v;
        if (f.other) S.info[f.name + "_other"] = r[f.name + "_other"] || "";
      });
      var restore = function (kind) { D[kind].items.forEach(function (it) { var v = r[it.id + "_raw"]; S[kind][it.id] = v == null ? "" : String(v); }); };
      restore("hlpre"); S.hlPreCompleted = true;
      restore("pre");
      S.preCompleted = true; S.read = D.sections.map(function (s) { return s.id; });
      S.stage1Saved = true; S.unlockAt = j.unlock_at;
      if (r.status === "ทำครบ") {
        restore("hlpost"); S.hlPostCompleted = true;
        restore("post");
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
    var change = function (a, b) {
      var d = a.mean != null && b.mean != null ? Math.round((b.mean - a.mean) * 100) / 100 : "";
      return { diff: d, pct: d !== "" && a.mean ? Math.round(d / a.mean * 1000) / 10 : "" };
    };
    var p = { action: "stage2", code: S.code, response_id: S.id, post_submitted_at_client: new Date().toISOString() };
    addScores(p, "hlpost", "hl_post");
    var hl = change(calc("hlpre"), calc("hlpost"));
    p.hl_score_diff = hl.diff;
    p.hl_pct_change = hl.pct;
    addScores(p, "post", "post");
    var bh = change(calc("pre"), calc("post"));
    p.score_diff = bh.diff;
    p.pct_change = bh.pct;
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
    var hlPre = calc("hlpre"), hlPost = calc("hlpost"), hlMax = D.hlpre.scoreMax;
    function scoreBox(label, r, cls, mx) {
      mx = mx || max;
      var badge = r.level ? '<span class="badge ' + r.level.key + '">' + r.level.label + "</span>" : '<span class="badge">ไม่มีข้อมูล</span>';
      return '<div class="score ' + cls + '"><div class="s-label">' + label + '</div><div class="s-num">' + (r.mean == null ? "—" : r.mean.toFixed(2)) + " <small>/ " + mx + "</small></div>" + badge +
        '<div class="s-sub">' + (r.n ? "คะแนนรวม " + r.total + " จาก " + (r.n * mx) + " (" + r.n + " ข้อ)" : "") + "</div></div>";
    }
    function bar(label, r, cls, mx) {
      mx = mx || max;
      var w = r.mean == null ? 0 : (r.mean / mx) * 100;
      return '<div class="bar-row"><span>' + label + '</span><div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + Math.max(w, 2) + '%"></div></div><span>' + (r.mean == null ? "—" : r.mean.toFixed(2)) + "</span></div>";
    }
    // ความรอบรู้: คะแนนเพิ่มขึ้น = ดีขึ้น
    var hlChange = "";
    if (hlPre.mean != null && hlPost.mean != null) {
      var hd = Math.round((hlPost.mean - hlPre.mean) * 100) / 100;
      hlChange = '<p class="change ' + (hd > 0 ? "good" : hd < 0 ? "bad" : "") + '">' +
        (hd > 0 ? "▲ คะแนนความรอบรู้เพิ่มขึ้น " + hd.toFixed(2) + " คะแนน" : hd < 0 ? "▼ คะแนนความรอบรู้ลดลง " + Math.abs(hd).toFixed(2) + " คะแนน" : "● คะแนนความรอบรู้เท่าเดิม") + "</p>";
    }
    var hlMain = hlPost.level || hlPre.level;
    var hlLevels = D.hlpre.levels.slice().reverse();
    var hlCriteria = hlLevels.map(function (l, i) {
      var hi = i < hlLevels.length - 1 ? (hlLevels[i + 1].min - 0.01).toFixed(2) : hlMax.toFixed(2);
      return Math.max(l.min, 1).toFixed(2) + "–" + hi + " " + l.label.replace("ความรอบรู้", "");
    }).join(" · ");
    var hlHtml =
      '<h3 class="sum-h">1. ความรอบรู้ด้านสุขภาพเกี่ยวกับโรคซิฟิลิส</h3>' +
      '<p class="muted">คะแนนเฉลี่ย 1–' + hlMax + ' <strong>คะแนนยิ่งสูง ยิ่งมีความรอบรู้มาก</strong></p>' +
      '<div class="score-grid">' + scoreBox("ก่อนเข้าร่วมโปรแกรม", hlPre, "before", hlMax) + scoreBox("หลังเข้าร่วมโปรแกรม", hlPost, "after", hlMax) + "</div>" +
      '<div class="bars">' + bar("ก่อน", hlPre, "before", hlMax) + bar("หลัง", hlPost, "after", hlMax) + "</div>" + hlChange +
      (hlMain ? '<div class="advice ' + hlMain.key + '"><h4>' + hlMain.label + "</h4><p>" + esc(hlMain.message) + "</p></div>" : "") +
      '<p class="muted small">เกณฑ์: ' + hlCriteria + "</p>";
    var change = "";
    if (pre.mean != null && post.mean != null) {
      var d = Math.round((post.mean - pre.mean) * 100) / 100;
      change = '<p class="change ' + (d < 0 ? "good" : d > 0 ? "bad" : "") + '">' +
        (d < 0 ? "▼ คะแนนความเสี่ยงลดลง " + Math.abs(d).toFixed(2) + " คะแนน" : d > 0 ? "▲ คะแนนความเสี่ยงเพิ่มขึ้น " + d.toFixed(2) + " คะแนน" : "● คะแนนความเสี่ยงเท่าเดิม") + "</p>";
    }
    var main = post.level || pre.level;
    $("#summaryCard").innerHTML =
      '<p class="eyebrow">ขั้นที่ 4 · ครั้งที่ 2 · สรุปผล</p><h2>ผลการประเมินของคุณ</h2>' + hlHtml +
      '<h3 class="sum-h">2. พฤติกรรมการป้องกันความเสี่ยงการเกิดโรคซิฟิลิส</h3>' +
      '<p class="muted">คะแนนเฉลี่ย 0–' + max + ' <strong>คะแนนยิ่งสูง ยิ่งมีความเสี่ยงต่อการติดเชื้อซิฟิลิสมาก</strong></p>' +
      '<div class="score-grid">' + scoreBox("ก่อนเข้าร่วมโปรแกรม", pre, "before") + scoreBox("หลังเข้าร่วมโปรแกรม", post, "after") + "</div>" +
      '<div class="bars">' + bar("ก่อน", pre, "before") + bar("หลัง", post, "after") + "</div>" + change +
      (main ? '<div class="advice ' + main.key + '"><h4>' + main.label + "</h4><p>" + esc(main.message) + '</p><p class="tips-h">คำแนะนำ</p><ul>' +
        main.tips.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></div>" : "") +
      '<p class="disclaimer">' + esc(D.disclaimer) + "</p>" +
      '<p class="muted small">เกณฑ์: 0.00–1.33 ความเสี่ยงต่ำ · 1.34–2.67 ความเสี่ยงปานกลาง · 2.68–4.00 ความเสี่ยงสูง</p>' +
      '<div class="save-status ok">✓ บันทึกคำตอบทั้ง 2 ครั้ง (ครั้งละ 2 ชุด) เรียบร้อยแล้ว</div>' +
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
    if (ASSESS.indexOf(v) > -1) renderAssess(v);
    if (v === "content") renderContent();
    if (v === "skills") renderSkills();
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
