(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var D = window.APP_DATA;
  var PW_KEY = "sexed_admin_pw";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ST = { rows: [], filtered: [], demo: false, fetchedAt: null, sort: { key: "started", dir: -1 }, page: 1, perPage: 25, password: "" };

  /* ======================================================
     เครื่องมือ
     ====================================================== */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function num(v) { return v == null || v === "" || isNaN(v) ? null : Number(v); }
  function f2(v) { return v == null ? "—" : v.toFixed(2); }
  function f1(v) { return v == null ? "—" : v.toFixed(1); }
  function signed(v, d) { if (v == null) return "—"; var s = v.toFixed(d); return v > 0 ? "+" + s : s; }
  var toastTimer;
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  /* ---------- วันที่ (เวลาไทย พ.ศ.) ---------- */
  var dtf = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function parts(iso) {
    if (!iso) return null;
    var d = new Date(iso); if (isNaN(d)) return null;
    var o = {}; dtf.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function fmtTH(iso) {
    var p = parts(iso); if (!p) return "—";
    return p.day + "/" + p.month + "/" + (Number(p.year) + 543) + " " + p.hour + ":" + p.minute;
  }
  function dayKey(iso) { var p = parts(iso); return p ? p.year + "-" + p.month + "-" + p.day : ""; }

  /* ======================================================
     คำนวณคะแนนจากคำตอบดิบ (ใช้เกณฑ์เดียวกับหน้าเว็บ)
     ====================================================== */
  function levelOf(mean) {
    if (mean == null) return null;
    for (var i = 0; i < D.levels.length; i++) if (mean >= D.levels[i].min) return D.levels[i];
    return D.levels[D.levels.length - 1];
  }
  function scoreSet(raw, kind) {
    var items = D[kind].items, scores = {}, sum = 0, n = 0;
    items.forEach(function (it) {
      var r = raw[it.id + "_raw"];
      var v = (r === "SKIP" || r === "NA" || r === "" || r == null || isNaN(r)) ? null : Number(r);
      var s = v == null ? null : (it.dir === "-" ? v : D.scoreMax - v); // คะแนนความเสี่ยง: สูง = เสี่ยงมาก
      scores[it.id] = s;
      if (s != null) { sum += s; n++; }
    });
    var mean = n ? Math.round((sum / n) * 100) / 100 : null;
    return { scores: scores, n: n, mean: mean, total: n ? sum : null, level: levelOf(mean) };
  }
  function enrich(r) {
    var pre = scoreSet(r, "pre"), post = scoreSet(r, "post");
    var diff = pre.mean != null && post.mean != null ? Math.round((post.mean - pre.mean) * 100) / 100 : null;
    var pct = diff != null && pre.mean ? Math.round((diff / pre.mean) * 1000) / 10 : null;
    var dir = diff == null ? "" : diff > 0 ? "ความเสี่ยงเพิ่มขึ้น" : diff < 0 ? "ความเสี่ยงลดลง" : "เท่าเดิม";
    return {
      raw: r,
      id: String(r.response_id || ""),
      started: r.started_at || r.received_at || "",
      finished: r.post_done_at || r.finished_at || "",
      duration: num(r.duration_min) != null ? num(r.duration_min) : (r.content_done_at && r.started_at ? Math.round((new Date(r.content_done_at) - new Date(r.started_at)) / 600) / 100 : null),
      isUbu: r.is_ubu_student || "",
      nonUbu: r.flag_non_ubu === "NON-UBU" || r.is_ubu_student === "ไม่ใช่",
      gender: r.gender || "", year: r.year || "", faculty: r.faculty || "",
      prior: r.info_sources || r.prior_knowledge || "", preSex: r.pre_sex || "", postSex: r.post_sex || "", sex: r.ever_sex || "", consent: r.consent || "",
      pre: pre, post: post, diff: diff, pct: pct, dir: dir,
      topics: num(r.content_topics_read), thank: r.thank_msg_no || "", received: r.received_at || "",
      status: r.status || (r.post_done_at || r.post1_raw ? "ทำครบ" : "รอทำหลังเรียน"),
      contentDone: r.content_done_at || "", unlockAt: r.unlock_at || "", postDone: r.post_done_at || "",
      gap: num(r.gap_days), emailStatus: r.email_reminder || "",
      sat: D.satisfaction.reduce(function (o, q) { o[q.id] = num(r[q.id]); return o; }, {}),
      satComment: r.sat_comment ? String(r.sat_comment).replace(/^'/, "") : "", satAt: r.satisfaction_at || ""
    };
  }

  /* ======================================================
     สถิติ: paired t-test
     ====================================================== */
  function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
  function sd(a) {
    if (a.length < 2) return null;
    var m = mean(a), s = 0;
    a.forEach(function (x) { s += (x - m) * (x - m); });
    return Math.sqrt(s / (a.length - 1));
  }
  function lgamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    var MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; var del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function pTwoTailed(t, df) { return ibeta(df / (df + t * t), df / 2, 0.5); }
  function tCrit(df, alpha) { // ค่าวิกฤตสองหาง ด้วยการค้นหาแบบแบ่งครึ่ง
    var lo = 0, hi = 1000;
    for (var i = 0; i < 200; i++) { var mid = (lo + hi) / 2; if (pTwoTailed(mid, df) > alpha) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function pairedT(rows) {
    var pairs = rows.filter(function (r) { return r.diff != null; });
    var n = pairs.length;
    var pre = pairs.map(function (r) { return r.pre.mean; });
    var post = pairs.map(function (r) { return r.post.mean; });
    var d = pairs.map(function (r) { return r.post.mean - r.pre.mean; });
    var res = { n: n, preM: n ? mean(pre) : null, preSD: sd(pre), postM: n ? mean(post) : null, postSD: sd(post), dM: n ? mean(d) : null, dSD: sd(d) };
    if (n >= 2 && res.dSD > 0) {
      var se = res.dSD / Math.sqrt(n);
      res.df = n - 1;
      res.t = res.dM / se;
      res.p = pTwoTailed(Math.abs(res.t), res.df);
      var tc = tCrit(res.df, 0.05);
      res.ciLo = res.dM - tc * se; res.ciHi = res.dM + tc * se;
      res.dz = res.dM / res.dSD;
    }
    return res;
  }

  /* ======================================================
     ข้อมูลสมมติ (โหมดตัวอย่าง)
     ====================================================== */
  function demoRows() {
    var seed = 7; function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    function pick(a) { return a[Math.floor(rnd() * a.length)]; }
    var rows = [], now = Date.now();
    for (var i = 0; i < 64; i++) {
      var everSex = rnd() < 0.62 ? "เคย" : "ไม่เคย";
      var ubu = rnd() < 0.93;
      var start = new Date(now - Math.floor(rnd() * 26 * 864e5) - Math.floor(rnd() * 8 * 36e5));
      var mins = 8 + Math.floor(rnd() * 18);
      var cDone = new Date(start.getTime() + mins * 6e4), unlock = new Date(cDone.getTime() + 7 * 864e5);
      var gap = 7 + rnd() * 4, postDone = new Date(cDone.getTime() + gap * 864e5);
      var done = postDone.getTime() < now && rnd() < 0.85;
      var r = {
        response_id: "R-DEMO" + String(100 + i), started_at: start.toISOString(),
        content_done_at: cDone.toISOString(), unlock_at: unlock.toISOString(), duration_min: mins,
        status: done ? "ทำครบ" : "รอทำหลังเรียน", email_reminder: unlock.getTime() < now ? "ส่งแล้ว" : "รอส่ง",
        is_ubu_student: ubu ? "ใช่" : "ไม่ใช่", flag_non_ubu: ubu ? "" : "NON-UBU",
        gender: pick(D.genders), year: pick(D.years), faculty: ubu ? pick(D.faculties) : "อื่น ๆ (ไม่ใช่นักศึกษา ม.อุบลฯ)",
        info_sources: rnd() < 0.15 ? D.infoSourceNone : D.infoSources.filter(function () { return rnd() < 0.4; }).join("; ") || D.infoSources[0], ever_sex: everSex, consent: "ยินยอม",
        content_topics_read: 9, thank_msg_no: 1 + Math.floor(rnd() * 5), received_at: start.toISOString()
      };
      var base = 1.2 + rnd() * 2.2; // ระดับความเสี่ยงพื้นฐาน 0–4
      r.pre_sex = everSex === "ไม่เคย" || rnd() < 0.2 ? "ไม่มี" : "มี";
      D.pre.items.forEach(function (it) {
        if (it.sex && r.pre_sex === "ไม่มี") { r[it.id + "_raw"] = "SKIP"; return; }
        var risk = Math.max(0, Math.min(4, Math.round(base + (rnd() - 0.5) * 1.8)));
        r[it.id + "_raw"] = it.dir === "-" ? risk : 4 - risk;
      });
      var lift = 0.2 + rnd() * 0.8; // ความเสี่ยงลดลงหลังเรียน
      if (done) {
        r.post_done_at = postDone.toISOString(); r.gap_days = Math.round(gap * 100) / 100;
        r.post_sex = r.pre_sex === "ไม่มี" || rnd() < 0.45 ? "ไม่มี" : "มี";
        D.post.items.forEach(function (it) {
          if (it.sex && r.post_sex === "ไม่มี") { r[it.id + "_raw"] = "SKIP"; return; }
          var risk = Math.max(0, Math.min(4, Math.round(base - lift + (rnd() - 0.5) * 1.6)));
          r[it.id + "_raw"] = it.dir === "-" ? risk : 4 - risk;
        });
        if (rnd() < 0.75) {
          r.satisfaction_at = postDone.toISOString();
          D.satisfaction.forEach(function (q) { if (rnd() < 0.92) r[q.id] = Math.max(2, Math.min(5, Math.round(3.6 + rnd() * 1.6))); });
          if (rnd() < 0.4) r.sat_comment = pick(["อินโฟกราฟิกเข้าใจง่ายมาก", "อยากให้มีวิดีโอเพิ่ม", "ตัวหนังสือในมือถือเล็กไปนิด", "ได้ความรู้ใหม่เยอะ ขอบคุณค่ะ", "รอ 1 สัปดาห์นานไปหน่อย"]);
        }
      }
      rows.push(r);
    }
    return rows;
  }

  /* ======================================================
     เข้าสู่ระบบ / ดึงข้อมูล
     ====================================================== */
  function showLogin(msg) {
    $("#appView").hidden = true; $("#loginView").hidden = false;
    $("#demoBox").hidden = !!CFG.SCRIPT_URL;
    if (msg) { $("#loginErr").textContent = msg; $("#loginErr").hidden = false; }
    setTimeout(function () { $("#pw").focus(); }, 50);
  }
  function showApp() {
    $("#loginView").hidden = true; $("#appView").hidden = false;
    $("#demoBanner").hidden = !ST.demo;
  }

  var ERRORS = {
    wrong_password: "รหัสผ่านไม่ถูกต้อง ลองใหม่อีกครั้ง",
    locked: "ใส่รหัสผิดหลายครั้งเกินไป ระบบล็อกไว้ 10 นาที ลองใหม่ภายหลัง",
    no_password_set: "ยังไม่ได้ตั้งรหัสผ่านแอดมินใน Apps Script (ดูคู่มือ ขั้นตอนที่ 1 ข้อ 9)",
    busy: "ระบบกำลังทำงานหนัก (มีผู้ตอบพร้อมกันจำนวนมาก) ลองรีเฟรชอีกครั้งในไม่กี่วินาที",
    network: "เชื่อมต่อ Google Sheets ไม่ได้ ตรวจอินเทอร์เน็ต หรือเช็กว่า Deploy Apps Script เวอร์ชันล่าสุดแล้ว",
    no_url: "ยังไม่ได้ใส่ SCRIPT_URL ในไฟล์ config.js"
  };

  function fetchRows(password, attempt) {
    if (!CFG.SCRIPT_URL) return Promise.reject("no_url");
    attempt = attempt || 0;
    return fetchOnce(password).catch(function (err) {
      if (["wrong_password", "locked", "no_password_set", "no_url"].indexOf(err) > -1 || attempt >= 2) throw err;
      return new Promise(function (r) { setTimeout(r, 1500 * (attempt + 1)); }).then(function () { return fetchRows(password, attempt + 1); });
    });
  }
  function fetchOnce(password) {
    return fetch(CFG.SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "admin_list", password: password }),
      cache: "no-store"
    }).then(function (res) { return res.json(); }, function () { throw "network"; })
      .then(function (j) { if (!j || !j.ok) throw (j && j.error) || "network"; return j; });
  }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    if (label) btn.textContent = busy ? label : btn.getAttribute("data-label");
  }

  $("#loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("#pw").value;
    $("#loginErr").hidden = true;
    if (!pw) { $("#loginErr").textContent = "กรุณาใส่รหัสผ่าน"; $("#loginErr").hidden = false; return; }
    var btn = $("#loginBtn"); btn.setAttribute("data-label", "เข้าสู่ระบบ"); setBusy(btn, true, "กำลังตรวจสอบ…");
    fetchRows(pw).then(function (j) {
      ST.password = pw; ST.demo = false; ssSet(PW_KEY, pw);
      load(j.rows, j.fetched_at);
      $("#pw").value = "";
      showApp();
    }).catch(function (err) {
      $("#loginErr").textContent = ERRORS[err] || ERRORS.network; $("#loginErr").hidden = false;
      $("#pw").select();
    }).then(function () { setBusy(btn, false, true); });
  });
  $("#pwToggle").addEventListener("click", function () {
    var i = $("#pw"), show = i.type === "password";
    i.type = show ? "text" : "password";
    this.textContent = show ? "ซ่อน" : "แสดง";
    this.setAttribute("aria-pressed", show);
    this.setAttribute("aria-label", show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน");
  });
  $("#demoBtn").addEventListener("click", function () {
    ST.demo = true; load(demoRows(), new Date().toISOString()); showApp();
  });
  $("#logoutBtn").addEventListener("click", function () {
    ssDel(PW_KEY); ST = { rows: [], filtered: [], demo: false, fetchedAt: null, sort: { key: "started", dir: -1 }, page: 1, perPage: 25, password: "" };
    showLogin(); toast("ออกจากระบบแล้ว");
  });
  $("#refreshBtn").addEventListener("click", function () {
    var btn = this; btn.setAttribute("data-label", btn.innerHTML);
    btn.disabled = true; btn.textContent = "กำลังโหลด…";
    var done = function () { btn.disabled = false; btn.innerHTML = btn.getAttribute("data-label"); };
    if (ST.demo) { setTimeout(function () { load(demoRows(), new Date().toISOString(), true); done(); toast("รีเฟรชแล้ว (ข้อมูลสมมติ)"); }, 300); return; }
    fetchRows(ST.password).then(function (j) { load(j.rows, j.fetched_at, true); toast("รีเฟรชแล้ว · " + j.rows.length + " รายการ"); })
      .catch(function (err) {
        if (err === "wrong_password" || err === "locked") { ssDel(PW_KEY); showLogin(ERRORS[err]); }
        else toast(ERRORS[err] || ERRORS.network);
      }).then(done);
  });

  /* ======================================================
     โหลดข้อมูล + ตัวกรอง
     ====================================================== */
  function load(rows, fetchedAt, keepFilters) {
    ST.rows = (rows || []).filter(function (r) { return r && r.response_id; }).map(enrich);
    ST.fetchedAt = fetchedAt;
    $("#fetchedAt").textContent = "ดึงข้อมูลล่าสุด " + fmtTH(fetchedAt) + " น.";
    if (!keepFilters) buildFilterOptions(); else refreshFilterOptions();
    apply();
  }

  function uniq(key, order) {
    var seen = {};
    ST.rows.forEach(function (r) { if (r[key]) seen[r[key]] = true; });
    var vals = Object.keys(seen);
    if (order) vals.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b, "th");
    });
    return vals;
  }
  var FILTERS = [
    { el: "#fFaculty", key: "faculty", all: "ทุกคณะ", order: D.faculties },
    { el: "#fGender", key: "gender", all: "ทุกเพศ", order: D.genders },
    { el: "#fYear", key: "year", all: "ทุกชั้นปี", order: D.years },
    { el: "#fSex", key: "sex", all: "ทั้งหมด", order: ["เคย", "ไม่เคย"] },
    { el: "#fStatus", key: "status", all: "ทุกสถานะ", order: ["ทำครบ", "รอทำหลังเรียน"] }
  ];
  function buildFilterOptions() {
    FILTERS.forEach(function (f) {
      var sel = $(f.el), cur = sel.value;
      var vals = uniq(f.key, f.order);
      f.order.forEach(function (o) { if (vals.indexOf(o) < 0 && f.key !== "faculty") vals.push(o); });
      sel.innerHTML = '<option value="">' + f.all + "</option>" + vals.map(function (v) { return "<option" + (v === cur ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");
    });
  }
  function refreshFilterOptions() { buildFilterOptions(); }

  function apply() {
    var q = $("#q").value.trim().toLowerCase();
    var fv = {}; FILTERS.forEach(function (f) { fv[f.key] = $(f.el).value; });
    var from = $("#fFrom").value, to = $("#fTo").value, ubu = $("#fUbu").checked;
    ST.filtered = ST.rows.filter(function (r) {
      if (ubu && r.nonUbu) return false;
      for (var k in fv) if (fv[k] && r[k] !== fv[k]) return false;
      var dk = dayKey(r.started);
      if (from && dk < from) return false;
      if (to && dk > to) return false;
      if (q) {
        var hay = [r.id, r.faculty, r.gender, r.year, r.sex, r.dir, r.status, r.pre.level && r.pre.level.label, r.post.level && r.post.level.label, fmtTH(r.started), r.nonUbu ? "non-ubu" : ""].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    sortRows();
    ST.page = 1;
    var hidden = ST.rows.length - ST.filtered.length;
    $("#resultCount").textContent = "แสดง " + ST.filtered.length + " จาก " + ST.rows.length + " รายการ" + (ubu && ST.rows.some(function (r) { return r.nonUbu; }) ? " · ซ่อน NON-UBU " + ST.rows.filter(function (r) { return r.nonUbu; }).length : "");
    renderKpis(); renderStats(); renderLevelChart(); renderFacultyChart(); renderSatisfaction(); renderTable();
  }

  var deb;
  $("#q").addEventListener("input", function () { clearTimeout(deb); deb = setTimeout(apply, 180); });
  ["#fFaculty", "#fGender", "#fYear", "#fSex", "#fStatus", "#fFrom", "#fTo", "#fUbu"].forEach(function (s) { $(s).addEventListener("change", apply); });
  $("#clearBtn").addEventListener("click", function () {
    $("#q").value = ""; FILTERS.forEach(function (f) { $(f.el).value = ""; });
    $("#fFrom").value = ""; $("#fTo").value = ""; $("#fUbu").checked = true; apply();
  });

  /* ======================================================
     การ์ดสรุป
     ====================================================== */
  // ร้อยละการเปลี่ยนแปลงของทั้งกลุ่ม = (ค่าเฉลี่ยหลัง − ค่าเฉลี่ยก่อน) ÷ ค่าเฉลี่ยก่อน × 100 (เฉพาะผู้ที่ทำครบ)
  function groupPct(rows) {
    var pairs = rows.filter(function (r) { return r.diff != null; });
    if (!pairs.length) return "";
    var mPre = mean(pairs.map(function (r) { return r.pre.mean; })), mPost = mean(pairs.map(function (r) { return r.post.mean; }));
    if (!mPre) return "";
    return "ร้อยละการเปลี่ยนแปลงของกลุ่ม " + signed((mPost - mPre) / mPre * 100, 1) + "%";
  }
  function renderKpis() {
    var rows = ST.filtered;
    var pres = rows.map(function (r) { return r.pre.mean; }).filter(function (x) { return x != null; });
    var posts = rows.map(function (r) { return r.post.mean; }).filter(function (x) { return x != null; });
    var diffs = rows.map(function (r) { return r.diff; }).filter(function (x) { return x != null; });
    var pcts = rows.map(function (r) { return r.pct; }).filter(function (x) { return x != null; });
    var up = diffs.filter(function (d) { return d > 0; }).length, down = diffs.filter(function (d) { return d < 0; }).length, same = diffs.length - up - down; // up = ความเสี่ยงเพิ่ม
    var noPre = rows.length - pres.length;
    function k(label, val, sub, cls) { return '<div class="kpi ' + (cls || "") + '"><div class="k-l">' + label + '</div><div class="k-v">' + val + '</div><div class="k-s">' + (sub || "") + "</div></div>"; }
    $("#kpis").innerHTML =
      k("ผู้ตอบ (ตามตัวกรอง)", rows.length, "ทำครบ " + rows.filter(function (r) { return r.status === "ทำครบ"; }).length + " · รอทำหลังเรียน " + rows.filter(function (r) { return r.status !== "ทำครบ"; }).length + (noPre ? "<br>ไม่มีคะแนนก่อน " + noPre + " คน" : "")) +
      k("คะแนนความเสี่ยงก่อน<br><small>3 เดือนที่ผ่านมา · 0–4</small>", pres.length ? f2(mean(pres)) : "—", pres.length ? "SD " + f2(sd(pres)) + " · n = " + pres.length : "", "before") +
      k("คะแนนความเสี่ยงหลัง<br><small>1 สัปดาห์ที่ผ่านมา · 0–4</small>", posts.length ? f2(mean(posts)) : "—", posts.length ? "SD " + f2(sd(posts)) + " · n = " + posts.length : "", "after") +
      k("ผลต่างเฉลี่ย (หลัง − ก่อน)", diffs.length ? signed(mean(diffs), 2) : "—", groupPct(rows)) +
      '<div class="kpi"><div class="k-l">ทิศทางความเสี่ยง</div><div class="dir"><span class="up">▼ ' + down + '</span><span class="same">● ' + same + '</span><span class="down">▲ ' + up + "</span></div>" +
      '<div class="k-s">ลดลง / เท่าเดิม / เพิ่มขึ้น' + (diffs.length ? " (n = " + diffs.length + ")" : "") + "</div></div>";
  }

  /* ======================================================
     สถิติ
     ====================================================== */
  function fmtP(p) { if (p == null) return "—"; return p < 0.001 ? "< .001" : p.toFixed(3).replace(/^0/, ""); }
  function renderStats() {
    var t = pairedT(ST.filtered), box = $("#stats");
    if (t.n < 2) { box.innerHTML = '<div class="empty"><strong>ข้อมูลไม่พอ</strong>ต้องมีผู้ที่มีคะแนนทั้งก่อนและหลังอย่างน้อย 2 คน</div>'; return; }
    var html = '<table class="stat-tbl"><thead><tr><th></th><th>n</th><th>Mean</th><th>SD</th></tr></thead><tbody>' +
      "<tr><td>ก่อน (พฤติกรรม 3 เดือนที่ผ่านมา)</td><td>" + t.n + "</td><td>" + f2(t.preM) + "</td><td>" + f2(t.preSD) + "</td></tr>" +
      "<tr><td>หลัง (พฤติกรรม 1 สัปดาห์ที่ผ่านมา)</td><td>" + t.n + "</td><td>" + f2(t.postM) + "</td><td>" + f2(t.postSD) + "</td></tr>" +
      "<tr><td>ผลต่าง (หลัง − ก่อน)</td><td>" + t.n + "</td><td>" + signed(t.dM, 2) + "</td><td>" + f2(t.dSD) + "</td></tr></tbody></table>";
    if (t.t == null) {
      html += '<p class="interp">ทุกคนมีผลต่างเท่ากัน (SD ของผลต่าง = 0) จึงคำนวณ t-test ไม่ได้</p>';
    } else {
      var sig = t.p < 0.05;
      html += '<div class="ttest"><div><span>t</span><strong>' + t.t.toFixed(3) + "</strong></div><div><span>df</span><strong>" + t.df + "</strong></div>" +
        "<div><span>p (สองหาง)</span><strong>" + fmtP(t.p) + "</strong></div><div><span>Cohen's d<sub>z</sub></span><strong>" + t.dz.toFixed(2) + "</strong></div></div>" +
        '<p class="muted small" style="margin-top:8px">95% CI ของผลต่างเฉลี่ย: ' + signed(t.ciLo, 2) + " ถึง " + signed(t.ciHi, 2) + "</p>" +
        '<p class="interp' + (sig ? " sig" : "") + '">' + (sig
          ? "คะแนนพฤติกรรมเสี่ยงหลังเรียน" + (t.dM > 0 ? "สูงกว่า" : "ต่ำกว่า") + "ก่อนเรียนอย่างมีนัยสำคัญทางสถิติที่ระดับ .05"
          : "คะแนนพฤติกรรมเสี่ยงก่อนและหลังเรียนไม่แตกต่างกันอย่างมีนัยสำคัญทางสถิติที่ระดับ .05") +
        " · หมายเหตุ: ก่อนเรียนถามย้อนหลัง 3 เดือน หลังเรียนถามย้อนหลัง 1 สัปดาห์ (ห่างกันอย่างน้อย 7 วัน)</p>";
    }
    box.innerHTML = html;
  }

  /* ======================================================
     กราฟ
     ====================================================== */
  function hbarGroup(label, sub, a, b, max, fmt) {
    function bar(v, cls) {
      var w = v == null ? 0 : Math.max(0, v / max * 100);
      return '<div class="hbar"><div class="hbar-track"><div class="hbar-fill ' + cls + '" style="width:' + w + '%"></div></div><span>' + (v == null ? "—" : fmt(v)) + "</span></div>";
    }
    return '<div class="hbar-group"><div class="hbar-label">' + esc(label) + (sub ? "<small>" + esc(sub) + "</small>" : "") + '</div><div class="hbar-bars">' + bar(a, "before") + bar(b, "after") + "</div></div>";
  }
  function renderLevelChart() {
    var rows = ST.filtered;
    var counts = D.levels.map(function (lv) {
      return {
        label: lv.label,
        pre: rows.filter(function (r) { return r.pre.level && r.pre.level.key === lv.key; }).length,
        post: rows.filter(function (r) { return r.post.level && r.post.level.key === lv.key; }).length
      };
    });
    var max = Math.max.apply(null, counts.map(function (c) { return Math.max(c.pre, c.post); }).concat([1]));
    $("#levelChart").innerHTML = rows.length ? counts.map(function (c) {
      return hbarGroup(c.label, "", c.pre, c.post, max, function (v) { return v + " คน"; });
    }).join("") : '<div class="empty">ไม่มีข้อมูลตามตัวกรอง</div>';
  }
  function renderFacultyChart() {
    var by = {};
    ST.filtered.forEach(function (r) {
      var k = r.faculty || "ไม่ระบุ";
      (by[k] = by[k] || { n: 0, pre: [], post: [] }).n++;
      if (r.pre.mean != null) by[k].pre.push(r.pre.mean);
      if (r.post.mean != null) by[k].post.push(r.post.mean);
    });
    var keys = Object.keys(by).sort(function (a, b) {
      var ia = D.faculties.indexOf(a), ib = D.faculties.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    $("#facultyChart").innerHTML = keys.length ? keys.map(function (k) {
      var g = by[k];
      return hbarGroup(k, "n = " + g.n, g.pre.length ? mean(g.pre) : null, g.post.length ? mean(g.post) : null, 4, function (v) { return v.toFixed(2); });
    }).join("") : '<div class="empty">ไม่มีข้อมูลตามตัวกรอง</div>';
  }

  /* ======================================================
     ตาราง
     ====================================================== */
  /* ---------- ความพึงพอใจ ---------- */
  function renderSatisfaction() {
    var rows = ST.filtered, box = $("#satPanel");
    var answered = rows.filter(function (r) { return D.satisfaction.some(function (q) { return r.sat[q.id] != null; }) || r.satComment; });
    if (!answered.length) { box.innerHTML = '<div class="empty"><strong>ยังไม่มีผู้ประเมินความพึงพอใจ</strong>ส่วนนี้ไม่บังคับ จะมีข้อมูลเมื่อผู้ตอบทำครบและให้คะแนน</div>'; return; }
    var html = '<table class="stat-tbl"><thead><tr><th>ด้าน</th><th>n</th><th>Mean</th><th>SD</th><th>ระดับ</th></tr></thead><tbody>';
    D.satisfaction.forEach(function (q) {
      var v = rows.map(function (r) { return r.sat[q.id]; }).filter(function (x) { return x != null; });
      var m = v.length ? mean(v) : null;
      var lvl = m == null ? "—" : m >= 4.51 ? "มากที่สุด" : m >= 3.51 ? "มาก" : m >= 2.51 ? "ปานกลาง" : m >= 1.51 ? "น้อย" : "น้อยที่สุด";
      html += "<tr><td>" + esc(q.text) + "</td><td>" + v.length + "</td><td>" + (m == null ? "—" : '<span class="stars-mini" aria-hidden="true">★</span> ' + m.toFixed(2)) + "</td><td>" + f2(sd(v)) + "</td><td>" + lvl + "</td></tr>";
    });
    html += "</tbody></table>";
    var comments = answered.filter(function (r) { return r.satComment; });
    html += '<p class="muted small" style="margin-top:10px">เกณฑ์: 4.51–5.00 มากที่สุด · 3.51–4.50 มาก · 2.51–3.50 ปานกลาง · 1.51–2.50 น้อย · 1.00–1.50 น้อยที่สุด</p>';
    html += '<h3 class="cm-h">ข้อเสนอแนะ (' + comments.length + ")</h3>";
    html += comments.length ? '<ul class="comments">' + comments.map(function (r) { return "<li><p>" + esc(r.satComment) + "</p><small>" + esc(r.id) + " · " + fmtTH(r.satAt || r.postDone) + "</small></li>"; }).join("") + "</ul>" : '<p class="muted small">ยังไม่มีข้อเสนอแนะ</p>';
    box.innerHTML = html;
  }

  var COLS = [
    { key: "started", label: "วันเวลาเข้าทำ", get: function (r) { return r.started; }, show: function (r) { return fmtTH(r.started); } },
    { key: "id", label: "รหัสผู้ตอบ", get: function (r) { return r.id; }, show: function (r) { return esc(r.id) + (r.nonUbu ? ' <span class="tag">NON-UBU</span>' : ""); } },
    { key: "status", label: "สถานะ", get: function (r) { return r.status; }, show: function (r) { return r.status === "ทำครบ" ? '<span class="st done">ทำครบ</span>' : '<span class="st wait">รอหลังเรียน</span>'; } },
    { key: "faculty", label: "คณะ", get: function (r) { return r.faculty; }, show: function (r) { return esc(r.faculty); } },
    { key: "year", label: "ชั้นปี", get: function (r) { return r.year; }, show: function (r) { return esc(r.year); } },
    { key: "gender", label: "เพศ", get: function (r) { return r.gender; }, show: function (r) { return esc(r.gender); } },
    { key: "pre", label: "ก่อน <small>(พฤติกรรม 3 ด.)</small>", num: true, get: function (r) { return r.pre.mean; }, show: function (r) { return f2(r.pre.mean) + lvTag(r.pre.level); } },
    { key: "post", label: "หลัง <small>(1 สัปดาห์)</small>", num: true, get: function (r) { return r.post.mean; }, show: function (r) { return f2(r.post.mean) + lvTag(r.post.level); } },
    { key: "diff", label: "ผลต่าง", num: true, get: function (r) { return r.diff; }, show: function (r) { return dirSpan(r.diff, signed(r.diff, 2)); } },
    { key: "pct", label: "ร้อยละเปลี่ยนแปลง", num: true, get: function (r) { return r.pct; }, show: function (r) { return dirSpan(r.pct, r.pct == null ? "—" : signed(r.pct, 1) + "%"); } }
  ];
  function lvTag(l) { return l ? '<span class="lv ' + l.key + '">' + l.label + "</span>" : ""; }
  function dirSpan(v, txt) { if (v == null) return '<span class="same">—</span>'; return '<span class="' + (v < 0 ? "up" : v > 0 ? "down" : "same") + '">' + txt + "</span>"; } // ความเสี่ยงลด = สีเขียว

  function sortRows() {
    var col = COLS.filter(function (c) { return c.key === ST.sort.key; })[0], dir = ST.sort.dir;
    ST.filtered.sort(function (a, b) {
      var x = col.get(a), y = col.get(b);
      if (x == null || x === "") return 1; if (y == null || y === "") return -1; // ค่าว่างไว้ท้ายเสมอ
      if (typeof x === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), "th") * dir;
    });
  }
  function renderHead() {
    $("#tblHeadRow").innerHTML = COLS.map(function (c) {
      var active = ST.sort.key === c.key;
      var aria = active ? (ST.sort.dir > 0 ? "ascending" : "descending") : "none";
      return '<th scope="col" class="' + (c.num ? "num" : "") + '" aria-sort="' + aria + '"><button type="button" data-sort="' + c.key + '">' + c.label +
        '<span class="arrow" aria-hidden="true">' + (active ? (ST.sort.dir > 0 ? "▲" : "▼") : "↕") + "</span></button></th>";
    }).join("");
  }
  function renderTable() {
    renderHead();
    var rows = ST.filtered, per = ST.perPage, pages = Math.max(1, Math.ceil(rows.length / per));
    if (ST.page > pages) ST.page = pages;
    var slice = rows.slice((ST.page - 1) * per, ST.page * per);
    $("#tblBody").innerHTML = slice.map(function (r) {
      return '<tr tabindex="0" data-id="' + esc(r.id) + '" aria-label="ดูรายละเอียด ' + esc(r.id) + '">' + COLS.map(function (c) {
        return '<td class="' + (c.num ? "num" : "") + '">' + c.show(r) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    var empty = $("#emptyState");
    if (!ST.rows.length) { empty.hidden = false; empty.innerHTML = "<strong>ยังไม่มีคำตอบ</strong>เมื่อมีผู้ทำแบบประเมินเสร็จ คำตอบจะขึ้นที่นี่ กด “รีเฟรช” เพื่อโหลดใหม่"; }
    else if (!rows.length) { empty.hidden = false; empty.innerHTML = '<strong>ไม่พบรายการที่ตรงกับตัวกรอง</strong><button class="link" type="button" id="emptyClear">ล้างตัวกรอง</button>'; $("#emptyClear").addEventListener("click", function () { $("#clearBtn").click(); }); }
    else empty.hidden = true;
    $(".tbl-wrap").hidden = !rows.length;
    renderPager(pages);
  }
  function renderPager(pages) {
    var p = ST.page, html = "";
    if (pages <= 1) { $("#pager").innerHTML = ""; return; }
    html += '<button type="button" data-page="' + (p - 1) + '"' + (p === 1 ? " disabled" : "") + ' aria-label="หน้าก่อน">‹</button>';
    var list = [];
    for (var i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - p) <= 1) list.push(i);
    var last = 0;
    list.forEach(function (i) {
      if (i - last > 1) html += "<span>…</span>";
      html += '<button type="button" data-page="' + i + '"' + (i === p ? ' aria-current="page"' : "") + ">" + i + "</button>";
      last = i;
    });
    html += '<button type="button" data-page="' + (p + 1) + '"' + (p === pages ? " disabled" : "") + ' aria-label="หน้าถัดไป">›</button>';
    $("#pager").innerHTML = html;
  }
  $("#tblHeadRow").addEventListener("click", function (e) {
    var b = e.target.closest("[data-sort]"); if (!b) return;
    var k = b.getAttribute("data-sort");
    ST.sort = ST.sort.key === k ? { key: k, dir: -ST.sort.dir } : { key: k, dir: k === "started" ? -1 : 1 };
    sortRows(); renderTable();
    var nb = $('[data-sort="' + k + '"]'); if (nb) nb.focus();
  });
  $("#pager").addEventListener("click", function (e) {
    var b = e.target.closest("[data-page]"); if (!b || b.disabled) return;
    ST.page = Number(b.getAttribute("data-page")); renderTable();
    $("#tblH").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#perPage").addEventListener("change", function () { ST.perPage = Number(this.value); ST.page = 1; renderTable(); });
  $("#tblBody").addEventListener("click", function (e) { var tr = e.target.closest("tr[data-id]"); if (tr) openDetail(tr.getAttribute("data-id")); });
  $("#tblBody").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest("tr[data-id]"); if (tr) { e.preventDefault(); openDetail(tr.getAttribute("data-id")); }
  });

  /* ======================================================
     รายละเอียดรายคน
     ====================================================== */
  function rawLabel(v) {
    if (v === "SKIP") return "ข้าม (ไม่มีเพศสัมพันธ์)";
    if (v === "NA") return "ไม่เกี่ยวข้อง";
    var s = D.scale.filter(function (x) { return String(x.value) === String(v); })[0];
    return s ? v + " · " + s.label : "—";
  }
  function openDetail(id) {
    var r = ST.rows.filter(function (x) { return x.id === id; })[0]; if (!r) return;
    function kv(l, v) { return "<div><span>" + l + "</span><strong>" + (v === "" || v == null ? "—" : v) + "</strong></div>"; }
    function answers(kind) {
      var set = D[kind], sc = r[kind];
      return '<h3 style="font-size:1rem;margin-top:6px">' + set.title + ' <small class="muted">(' + (kind === "pre" ? "พฤติกรรม 3 เดือนที่ผ่านมา" : "พฤติกรรม 1 สัปดาห์ที่ผ่านมา") + ')</small></h3>' +
        '<p class="small">' + esc(set.screen.text) + ": <strong>" + esc((kind === "pre" ? r.preSex : r.postSex) || "—") + "</strong></p>" +
        '<table class="ans-tbl"><thead><tr><th>ข้อ</th><th>คำตอบดิบ</th><th>คะแนน</th></tr></thead><tbody>' +
        set.items.map(function (it, i) {
          var s = sc.scores[it.id];
          return "<tr><td>" + (i + 1) + ". " + esc(it.text) + (it.dir === "-" ? '<span class="rev">ข้อพฤติกรรมเสี่ยง · คะแนน = คำตอบ</span>' : '<span class="rev ok">ข้อพฤติกรรมป้องกัน · คะแนน = 4 − คำตอบ</span>') + '</td><td class="num">' + esc(rawLabel(r.raw[it.id + "_raw"])) + '</td><td class="num">' + (s == null ? "—" : s) + "</td></tr>";
        }).join("") +
        '<tr><td><strong>คะแนนเฉลี่ย</strong></td><td class="num">n = ' + sc.n + '</td><td class="num"><strong>' + f2(sc.mean) + "</strong>" + lvTag(sc.level) + "</td></tr></tbody></table>";
    }
    $("#detailTitle").textContent = "ผู้ตอบ " + r.id;
    $("#detailBody").innerHTML =
      '<div class="kv">' +
      kv("วันเวลาเข้าทำ", fmtTH(r.started)) + kv("ทำเสร็จ", fmtTH(r.finished)) + kv("ใช้เวลาครั้งที่ 1", r.duration == null ? "" : r.duration.toFixed(1) + " นาที") +
      kv("นักศึกษา ม.อุบลฯ", esc(r.isUbu) + (r.nonUbu ? ' <span class="tag">NON-UBU</span>' : "")) + kv("เพศ", esc(r.gender)) + kv("ชั้นปี", esc(r.year)) +
      kv("คณะ", esc(r.faculty)) + kv("แหล่งข้อมูลเรื่องโรคติดต่อทางเพศสัมพันธ์", esc(r.prior)) + kv("เคยมีเพศสัมพันธ์", esc(r.sex)) +
      kv("ผลต่าง (หลัง − ก่อน)", dirSpan(r.diff, signed(r.diff, 2))) + kv("ร้อยละการเปลี่ยนแปลง", dirSpan(r.pct, r.pct == null ? "—" : signed(r.pct, 1) + "%")) +
      kv("อ่านเนื้อหา", r.topics == null ? "" : r.topics + " / " + D.sections.length + " หัวข้อ") +
      kv("สถานะ", esc(r.status)) + kv("อ่านเนื้อหาครบ (จบครั้งที่ 1)", fmtTH(r.contentDone)) + kv("ปลดล็อกหลังเรียน", fmtTH(r.unlockAt)) +
      kv("ทำหลังเรียน", fmtTH(r.postDone)) + kv("เว้นห่าง", r.gap == null ? "" : r.gap.toFixed(1) + " วัน") + kv("อีเมลเตือน", esc(r.emailStatus)) +
      "</div>" + answers("pre") + (r.status === "ทำครบ" ? answers("post") : '<p class="muted">ยังไม่ได้ทำแบบประเมินหลังเรียน</p>') +
      '<h3 style="font-size:1rem;margin-top:6px">ความพึงพอใจ</h3><table class="ans-tbl"><tbody>' +
      D.satisfaction.map(function (q) { var v = r.sat[q.id]; return "<tr><td>" + esc(q.text) + '</td><td class="num">' + (v == null ? "—" : "★".repeat(v) + " " + v) + "</td></tr>"; }).join("") +
      "<tr><td>ข้อเสนอแนะ</td><td>" + (r.satComment ? esc(r.satComment) : "—") + "</td></tr></tbody></table>";
    openDlg($("#detailDlg"));
  }

  /* ---------- dialog ---------- */
  var lastFocus = null;
  function openDlg(d) { lastFocus = document.activeElement; d.showModal(); var c = $(".dlg-close", d); if (c) c.focus(); }
  $$(".a-dialog").forEach(function (d) {
    d.addEventListener("click", function (e) { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
    d.addEventListener("close", function () { if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus(); });
  });

  /* ======================================================
     ส่งออก CSV
     ====================================================== */
  function buildExportCols() {
    var cols = [
      ["response_id", "รหัสผู้ตอบ", function (r) { return r.id; }],
      ["started_at_th", "วันเวลาเข้าทำ (เวลาไทย)", function (r) { return fmtTH(r.started); }],
      ["status", "สถานะ", function (r) { return r.status; }],
      ["content_done_at_th", "วันเวลาอ่านเนื้อหาครบ (จบครั้งที่ 1)", function (r) { return r.contentDone ? fmtTH(r.contentDone) : ""; }],
      ["unlock_at_th", "วันเวลาปลดล็อกหลังเรียน", function (r) { return r.unlockAt ? fmtTH(r.unlockAt) : ""; }],
      ["post_done_at_th", "วันเวลาทำหลังเรียน", function (r) { return r.postDone ? fmtTH(r.postDone) : ""; }],
      ["gap_days", "เว้นห่างจริง (วัน)", function (r) { return r.gap; }],
      ["email_reminder", "สถานะอีเมลเตือน", function (r) { return r.emailStatus; }],
      ["started_at_iso", "วันเวลาเข้าทำ (ISO, UTC)", function (r) { return r.started; }],
      ["duration_min", "ระยะเวลาครั้งที่ 1 (นาที)", function (r) { return r.duration; }],
      ["is_ubu_student", "เป็นนักศึกษา ม.อุบลฯ", function (r) { return r.isUbu; }],
      ["flag_non_ubu", "ป้ายคัดออก", function (r) { return r.nonUbu ? "NON-UBU" : ""; }],
      ["gender", "เพศ", function (r) { return r.gender; }],
      ["year", "ชั้นปี", function (r) { return r.year; }],
      ["faculty", "คณะ", function (r) { return r.faculty; }],
      ["info_sources", "แหล่งข้อมูลเรื่องโรคติดต่อทางเพศสัมพันธ์", function (r) { return r.prior; }],
      ["ever_sex", "เคยมีเพศสัมพันธ์", function (r) { return r.sex; }],
      ["consent", "การยินยอม", function (r) { return r.consent; }]
    ];
    ["pre", "post"].forEach(function (kind) {
      var tag = kind === "pre" ? "ก่อน" : "หลัง";
      cols.push([kind + "_sex", tag + " มีเพศสัมพันธ์ในช่วงที่ถาม (" + (kind === "pre" ? "3 เดือน" : "1 สัปดาห์") + ")", function (r) { return kind === "pre" ? r.preSex : r.postSex; }]);
      D[kind].items.forEach(function (it, i) {
        cols.push([it.id + "_raw", tag + " ข้อ " + (i + 1) + " คำตอบดิบ 0–4" + (it.dir === "-" ? " (ข้อเสี่ยง)" : " (ข้อป้องกัน)") + (it.sex ? " [ข้ามได้]" : ""), function (r) { var v = r.raw[it.id + "_raw"]; return v == null ? "" : v; }]);
      });
      D[kind].items.forEach(function (it, i) {
        cols.push([it.id + "_score", tag + " ข้อ " + (i + 1) + " คะแนนความเสี่ยง" + (it.dir === "-" ? "" : " (กลับคะแนนแล้ว)"), function (r) { var s = r[kind].scores[it.id]; return s == null ? "" : s; }]);
      });
      if (kind === "pre") {
        cols.push(["pre_n_answered", "ก่อน จำนวนข้อที่นำมาคิดคะแนน", function (r) { return r.pre.n; }]);
        cols.push(["pre_total", "คะแนนความเสี่ยงรวมก่อน", function (r) { return r.pre.total; }]);
        cols.push(["pre_mean", "คะแนนความเสี่ยงเฉลี่ยก่อน (3 เดือนที่ผ่านมา)", function (r) { return r.pre.mean; }]);
        cols.push(["pre_level", "ระดับก่อน", function (r) { return r.pre.level ? r.pre.level.label : ""; }]);
      } else {
        cols.push(["post_n_answered", "หลัง จำนวนข้อที่นำมาคิดคะแนน", function (r) { return r.post.n; }]);
        cols.push(["post_total", "คะแนนความเสี่ยงรวมหลัง", function (r) { return r.post.total; }]);
        cols.push(["post_mean", "คะแนนความเสี่ยงเฉลี่ยหลัง (1 สัปดาห์ที่ผ่านมา)", function (r) { return r.post.mean; }]);
        cols.push(["post_level", "ระดับหลัง", function (r) { return r.post.level ? r.post.level.label : ""; }]);
      }
    });
    cols.push(["score_diff", "ผลต่างคะแนนความเสี่ยง (หลัง − ก่อน, ติดลบ = เสี่ยงลดลง)", function (r) { return r.diff; }]);
    cols.push(["pct_change", "ร้อยละการเปลี่ยนแปลง", function (r) { return r.pct; }]);
    cols.push(["change_direction", "ทิศทางการเปลี่ยนแปลง", function (r) { return r.dir; }]);
    cols.push(["content_topics_read", "จำนวนหัวข้อเนื้อหาที่อ่าน", function (r) { return r.topics; }]);
    D.satisfaction.forEach(function (q) { cols.push([q.id, "ความพึงพอใจ: " + q.text, function (r) { return r.sat[q.id]; }]); });
    cols.push(["sat_comment", "ข้อเสนอแนะ", function (r) { return r.satComment; }]);
    return cols;
  }
  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(s)) s = "'" + s; // กันสูตรอันตรายใน Excel
    if (/[",\r\n]/.test(s) || /\s/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  $("#exportBtn").addEventListener("click", function () {
    $("#scopeFiltered").textContent = "เฉพาะที่กรองอยู่ (" + ST.filtered.length + " รายการ)";
    $("#scopeAll").textContent = "ทั้งหมด (" + ST.rows.length + " รายการ รวม NON-UBU)";
    openDlg($("#exportDlg"));
  });
  $("#doExport").addEventListener("click", function () {
    var lang = $('input[name="lang"]:checked').value, scope = $('input[name="scope"]:checked').value;
    var rows = scope === "all" ? ST.rows.slice().sort(function (a, b) { return String(a.started).localeCompare(String(b.started)); }) : ST.filtered;
    if (!rows.length) { toast("ไม่มีข้อมูลให้ส่งออก"); return; }
    var cols = buildExportCols();
    var lines = [cols.map(function (c) { return csvCell(lang === "th" ? c[1] : c[0]); }).join(",")];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvCell(c[2](r)); }).join(",")); });
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var p = parts(new Date().toISOString());
    var name = "sexeducation_" + (ST.demo ? "DEMO_" : "") + (scope === "all" ? "all" : "filtered") + "_" + lang + "_" + (Number(p.year) + 543) + p.month + p.day + "-" + p.hour + p.minute + ".csv";
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    $("#exportDlg").close();
    toast("ดาวน์โหลด " + rows.length + " รายการแล้ว");
  });

  /* ======================================================
     เริ่มต้น
     ====================================================== */
  // เผยฟังก์ชันสถิติไว้สำหรับทดสอบ
  window.__adminStats = { pairedT: pairedT, pTwoTailed: pTwoTailed, tCrit: tCrit };

  var saved = ssGet(PW_KEY);
  if (saved && CFG.SCRIPT_URL) {
    fetchRows(saved).then(function (j) { ST.password = saved; load(j.rows, j.fetched_at); showApp(); })
      .catch(function (err) { ssDel(PW_KEY); showLogin(err === "wrong_password" ? "" : ERRORS[err]); });
  } else {
    showLogin();
  }
})();
