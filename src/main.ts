import {
  submitApplicationToFirestore,
  subscribeToApplications,
  updateApplicationInFirestore,
  deleteApplicationFromFirestore,
  signInAdminWithGoogle,
  signInAdminWithRedirect,
  checkRedirectResult,
  signOutAdmin,
  onAdminAuthChanged,
  getAccessToken,
  ADMIN_EMAIL,
  type ApplicationRecord,
} from './firebase';
import {
  createParticipantSpreadsheet,
  syncApplicationsToSheet,
  saveSheetSettings,
  loadSheetSettings,
  type SheetSettings,
} from './sheets';
import type { Unsubscribe, User } from 'firebase/auth';

const $ = (id: string): any => document.getElementById(id);
const KEY = 'participant-applications:v1';
const SESSIONS = ['평일 저녁', '토요일 오전', '토요일 오후'];
const FIELDS = ['name', 'email', 'phone', 'org', 'session', 'motive', 'agree'];
const MSG = {
  nameMax: '최대 10글자 입니다',
  orgMax: '최대 50글자 입니다',
  emailBad: '올바른 이메일로 작성해주세요',
  emailDup: '이미 가입된 이메일입니다',
  phoneBad: '전화번호를 올바르게 입력해주세요',
  phoneDup: '이미 가입된 전화번호입니다',
};

/* =====================================================
   공통: 저장소 · 유틸 · 팝업 · 입력 필터 · 검증 규칙
   ===================================================== */
let memoryStore: ApplicationRecord[] = [];
let useMemory = false;
let cloudApplications: ApplicationRecord[] = [];
let firestoreUnsub: Unsubscribe | null = null;
let currentAdminUser: User | null = null;

function probeStorage(): boolean {
  try {
    const t = KEY + ':probe';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return true;
  } catch (_) {
    return false;
  }
}

function loadLocalBackup(): ApplicationRecord[] {
  if (useMemory) return memoryStore.slice();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r) => r && r.id) : [];
  } catch (_) {
    return [];
  }
}

function saveLocalBackup(list: ApplicationRecord[]): void {
  if (useMemory) {
    memoryStore = list.slice();
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (_) {}
}

function getAllApplications(): ApplicationRecord[] {
  // If Firestore subscription is active with records, use cloud records; otherwise fallback to local backup
  if (cloudApplications.length > 0 || isAuthed()) {
    return cloudApplications;
  }
  return loadLocalBackup();
}

const newId = (): string =>
  window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const pad = (n: number) => String(n).padStart(2, '0');
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
};
const fmtDateTime = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  return (
    d.getFullYear() +
    '.' +
    pad(d.getMonth() + 1) +
    '.' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
};

// 팝업 안내
const popupEl = $('popup');
let popupTimer: any = null;
function popup(msg: string, kind?: string) {
  if (!popupEl) return;
  const host = document.querySelector('dialog[open]') || document.body;
  if (popupEl.parentNode !== host) host.appendChild(popupEl);
  popupEl.textContent = msg;
  popupEl.className = 'popup' + (kind === 'ok' ? ' ok' : '');
  popupEl.hidden = false;
  clearTimeout(popupTimer);
  popupTimer = setTimeout(() => {
    popupEl.hidden = true;
  }, 2600);
}
popupEl?.addEventListener('click', () => {
  popupEl.hidden = true;
  clearTimeout(popupTimer);
});

// 허용 문자만 남기고 최대 글자 수에서 자른다
function bindLimited(el: HTMLInputElement | null, disallowed: RegExp, max: number, overMsg: string) {
  if (!el) return;
  let composing = false;
  const apply = () => {
    const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
    let v = el.value.replace(disallowed, '');
    const over = v.length > max;
    if (over) v = v.slice(0, max);
    if (v !== el.value) {
      const p = Math.min(el.value.slice(0, pos).replace(disallowed, '').length, v.length);
      el.value = v;
      try {
        el.setSelectionRange(p, p);
      } catch (_) {}
    }
    if (over) popup(overMsg);
  };
  el.addEventListener('compositionstart', () => {
    composing = true;
  });
  el.addEventListener('compositionend', () => {
    composing = false;
    apply();
  });
  el.addEventListener('input', (e: any) => {
    if (!composing && !e.isComposing) apply();
  });
}

const NAME_BAD = /[^A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/g;
const ORG_BAD = /[^A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ ]/g;

function formatPhone(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3);
  return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
}

function bindPhone(el: HTMLInputElement | null, errEl: HTMLElement | null) {
  if (!el || !errEl) return;
  el.addEventListener('input', () => {
    const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
    const digitsBefore = el.value.slice(0, pos).replace(/\D/g, '').length;
    const f = formatPhone(el.value);
    el.value = f;
    let p = 0,
      c = 0;
    while (p < f.length && c < digitsBefore) {
      if (/\d/.test(f[p])) c++;
      p++;
    }
    try {
      el.setSelectionRange(p, p);
    } catch (_) {}
    const digits = f.replace(/\D/g, '');
    errEl.textContent = '';
    el.removeAttribute('aria-invalid');
    if (digits.length >= 3 && digits.slice(0, 3) !== '010') {
      errEl.textContent = MSG.phoneBad;
      el.setAttribute('aria-invalid', 'true');
      popup(MSG.phoneBad);
    }
  });
}

function computeErrors(
  d: { name: string; email: string; phone: string; org: string; session: string; motive: string; agree: boolean },
  rawEmail: string,
  others: ApplicationRecord[],
  agreeMsg: string
) {
  const emailBad = !d.email || /\s/.test(rawEmail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email);
  const emailDup = !emailBad && others.some((r) => String(r.email || '').toLowerCase() === d.email.toLowerCase());
  const phoneBad = !!d.phone && !/^010-\d{4}-\d{4}$/.test(d.phone);
  const phoneDup = !!d.phone && !phoneBad && others.some((r) => r.phone === d.phone);
  return {
    name: !d.name
      ? '이름을 입력하세요.'
      : !/^[A-Za-z가-힣]+$/.test(d.name)
        ? '이름은 한글 또는 영문만 입력할 수 있어요.'
        : d.name.length > 10
          ? MSG.nameMax
          : '',
    email: emailBad ? MSG.emailBad : emailDup ? MSG.emailDup : '',
    phone: phoneBad ? MSG.phoneBad : phoneDup ? MSG.phoneDup : '',
    org: !/^[A-Za-z0-9가-힣 ]*$/.test(d.org)
      ? '소속은 한글·영문·숫자만 입력할 수 있어요.'
      : d.org.length > 50
        ? MSG.orgMax
        : '',
    session: d.session ? '' : '참가 일정을 하나 고르세요.',
    motive: d.motive.length >= 10 ? '' : '신청 동기를 10자 이상 적어 주세요.',
    agree: d.agree ? '' : agreeMsg,
  };
}

function applyErrors(errs: Record<string, string>, errPrefix: string, elFor: (k: string) => HTMLElement | null) {
  let first: HTMLElement | null = null;
  FIELDS.forEach((k) => {
    const errorEl = $(errPrefix + k);
    if (errorEl) errorEl.textContent = errs[k] || '';
    const el = elFor(k);
    if (el) el.setAttribute('aria-invalid', errs[k] ? 'true' : 'false');
    if (errs[k] && !first) first = el;
  });
  if (first) {
    (first as HTMLElement).focus();
    const msg = FIELDS.map((k) => errs[k]).find(Boolean);
    if (msg) popup(msg);
  }
  return !first;
}

function clearErrors(errPrefix: string, elFor: (k: string) => HTMLElement | null) {
  FIELDS.forEach((k) => {
    const errorEl = $(errPrefix + k);
    if (errorEl) errorEl.textContent = '';
    const el = elFor(k);
    if (el) el.removeAttribute('aria-invalid');
  });
}

/* =====================================================
   신청서 화면
   ===================================================== */
const form = $('form') as HTMLFormElement;
const submitBtn = $('submit') as HTMLButtonElement;
const statusEl = $('status');
const notice = $('notice');
const stamp = $('stamp');
const formEl = (k: string) => (k === 'session' ? form.querySelector('input[name="session"]') : $(k));

if ($('today')) $('today').textContent = fmtDate(Date.now());
$('motive')?.addEventListener('input', (e: any) => {
  if ($('count')) $('count').textContent = e.target.value.length;
});
bindLimited($('name'), NAME_BAD, 10, MSG.nameMax);
bindLimited($('org'), ORG_BAD, 50, MSG.orgMax);
bindPhone($('phone'), $('err-phone'));

function setStatus(text: string, kind?: string) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function showNotice(text: string, warn?: boolean) {
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = !text;
  notice.className = 'notice' + (warn ? ' warn' : '');
}

function showStamp(ms: number, animate?: boolean) {
  if (!stamp) return;
  if ($('stampDate')) $('stampDate').textContent = fmtDate(ms);
  stamp.classList.add('on');
  if (animate) {
    stamp.classList.remove('press');
    void stamp.offsetWidth;
    stamp.classList.add('press');
  }
}

function hideStamp() {
  stamp?.classList.remove('on', 'press');
}

function readForm() {
  const s = form.querySelector('input[name="session"]:checked') as HTMLInputElement;
  return {
    name: ($('name') as HTMLInputElement).value.trim(),
    email: ($('email') as HTMLInputElement).value.trim(),
    phone: ($('phone') as HTMLInputElement).value.trim(),
    org: ($('org') as HTMLInputElement).value.trim(),
    session: s ? s.value : '',
    motive: ($('motive') as HTMLTextAreaElement).value.trim(),
    agree: ($('agree') as HTMLInputElement).checked,
  };
}

function resetForm() {
  form.reset();
  if ($('count')) $('count').textContent = '0';
  clearErrors('err-', formEl);
}

form?.addEventListener('input', (e: any) => {
  hideStamp();
  if (statusEl?.classList.contains('good')) setStatus('');
  const k = e.target && e.target.name;
  if (k && k !== 'phone' && $('err-' + k)) {
    $('err-' + k).textContent = '';
    e.target.removeAttribute('aria-invalid');
  }
});

form?.addEventListener('submit', async (e: Event) => {
  e.preventDefault();
  const d = readForm();
  const existingList = getAllApplications();
  const errs = computeErrors(d, ($('email') as HTMLInputElement).value, existingList, '개인정보 수집·이용에 동의해야 제출할 수 있어요.');

  if (!applyErrors(errs, 'err-', formEl)) {
    setStatus('빨간색으로 표시된 항목을 확인하세요.', 'bad');
    return;
  }

  const now = Date.now();
  const docId = newId();
  const applicationRecord: ApplicationRecord = {
    id: docId,
    name: d.name,
    email: d.email,
    phone: d.phone || '',
    org: d.org || '',
    session: d.session,
    motive: d.motive,
    agree: d.agree,
    submittedAt: now,
    updatedAt: now,
  };

  submitBtn.disabled = true;
  setStatus('Firestore 데이터베이스에 접수 중...', '');

  try {
    // 1. Save directly to Cloud Firestore
    await submitApplicationToFirestore(applicationRecord);

    // 2. Also save to local backup
    const list = loadLocalBackup();
    list.push(applicationRecord);
    saveLocalBackup(list);

    resetForm();
    setStatus('신청서가 Firestore에 안전하게 접수되었습니다.', 'good');
    showStamp(now, true);
    popup('참가 신청이 완료되었습니다!', 'ok');
  } catch (err: any) {
    console.error('Firestore submission error:', err);
    let errorMsg = err.message || '인터넷 연결을 확인하세요.';
    try {
      const parsed = JSON.parse(errorMsg);
      if (parsed.error) errorMsg = parsed.error;
    } catch (_) {}
    setStatus('접수 중 오류가 발생했습니다: ' + errorMsg, 'bad');
    popup('제출에 실패했습니다: ' + errorMsg);
  } finally {
    submitBtn.disabled = false;
  }
});

/* =====================================================
   관리자 화면 (CRUD & Firestore 실시간 동기화)
   ===================================================== */
const state = {
  q: '',
  session: '',
  sort: 'new',
  page: 1,
  size: 10,
  selected: new Set<string>(),
  editingId: null as string | null,
};

function ask(title: string, msg: string, okLabel?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = $('confirm') as HTMLDialogElement;
    $('cfTitle').textContent = title;
    $('cfMsg').textContent = msg;
    $('cfOk').textContent = okLabel || '삭제';
    dlg.addEventListener(
      'close',
      () => {
        resolve(dlg.returnValue === 'ok');
      },
      { once: true }
    );
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

function maskName(n: string) {
  const a = Array.from(String(n || ''));
  return a.length <= 1 ? a.join('') : a[0] + '*'.repeat(a.length - 1);
}

function maskPhone(p: string) {
  const s = String(p || '');
  if (/^\d{3}-\d{4}-\d{4}$/.test(s)) return s.replace(/^(\d{3})-\d{4}-(\d{4})$/, '$1-****-$2');
  return s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : s;
}

function query() {
  const all = getAllApplications();
  const q = state.q.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const list = all.filter((r) => {
    if (state.session && r.session !== state.session) return false;
    if (!q) return true;
    const hay = [r.name, r.email, r.phone, r.org, r.motive].join('\n').toLowerCase();
    return hay.includes(q) || (qd.length >= 3 && String(r.phone || '').replace(/\D/g, '').includes(qd));
  });
  const bySub = (a: ApplicationRecord, b: ApplicationRecord) => (b.submittedAt || 0) - (a.submittedAt || 0);
  if (state.sort === 'old') list.sort((a, b) => -bySub(a, b));
  else if (state.sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko') || bySub(a, b));
  else if (state.sort === 'session')
    list.sort((a, b) => SESSIONS.indexOf(a.session) - SESSIONS.indexOf(b.session) || bySub(a, b));
  else list.sort(bySub);
  return { all, list };
}

function renderStats(all: ApplicationRecord[]) {
  const box = $('stats');
  if (!box) return;
  box.textContent = '';
  const items: [string, string, number][] = [
    ['', '전체', all.length],
    ...SESSIONS.map((s): [string, string, number] => [s, s, all.filter((r) => r.session === s).length]),
  ];
  items.forEach(([val, label, n]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stat';
    b.setAttribute('aria-pressed', state.session === val ? 'true' : 'false');
    const num = document.createElement('b');
    num.textContent = n + '건';
    const lab = document.createElement('span');
    lab.textContent = label;
    b.appendChild(num);
    b.appendChild(lab);
    b.addEventListener('click', () => {
      state.session = state.session === val ? '' : val;
      state.page = 1;
      if ($('fSession')) $('fSession').value = state.session;
      renderAdmin();
    });
    box.appendChild(b);
  });
}

function renderAdmin() {
  const { all, list } = query();
  const ids = new Set(all.map((r) => r.id));
  state.selected.forEach((id) => {
    if (!ids.has(id)) state.selected.delete(id);
  });

  renderStats(all);

  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / state.size));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.size;
  const slice = list.slice(start, start + state.size);

  const tbody = $('rows');
  if (!tbody) return;
  tbody.textContent = '';

  if (!slice.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.className = 'empty';
    td.textContent = all.length
      ? '조건에 맞는 신청서가 없어요.'
      : '아직 접수된 신청서가 없어요. ‘신규 등록’으로 추가할 수 있어요.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  slice.forEach((rec) => {
    const tr = document.createElement('tr');
    if (state.selected.has(rec.id)) tr.className = 'sel';

    const c0 = document.createElement('td');
    c0.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(rec.id);
    cb.setAttribute('aria-label', maskName(rec.name) + ' 선택');
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(rec.id);
      else state.selected.delete(rec.id);
      renderAdmin();
    });
    c0.appendChild(cb);
    tr.appendChild(c0);

    const cell = (text: string, cls?: string) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text || '—';
      tr.appendChild(td);
      return td;
    };

    const dt = cell(fmtDateTime(rec.submittedAt), 'nowrap');
    if (rec.updatedAt && rec.updatedAt !== rec.submittedAt) dt.title = '수정: ' + fmtDateTime(rec.updatedAt);
    cell(maskName(rec.name), 'nowrap');
    cell(rec.email);
    cell(maskPhone(rec.phone || ''), 'nowrap');
    cell(rec.org || '');

    const ts = document.createElement('td');
    if (rec.session) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = rec.session;
      ts.appendChild(tag);
    } else {
      ts.textContent = '—';
    }
    tr.appendChild(ts);

    const tm = document.createElement('td');
    tm.className = 'motive';
    const md = document.createElement('div');
    md.textContent = rec.motive || '—';
    md.title = rec.motive || '';
    tm.appendChild(md);
    tr.appendChild(tm);

    const act = document.createElement('td');
    act.className = 'act';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost mini';
    edit.textContent = '수정';
    edit.addEventListener('click', () => openEditor(rec));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger mini';
    del.textContent = '삭제';
    del.addEventListener('click', () =>
      removeRecords([rec.id], '‘' + maskName(rec.name) + '’ 님의 신청서를 삭제할까요? 되돌릴 수 없어요.')
    );

    act.appendChild(edit);
    act.appendChild(del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });

  const selCount = state.selected.size;
  if ($('selbar')) $('selbar').hidden = !selCount;
  if ($('selText')) $('selText').textContent = selCount + '건 선택됨';
  const inList = list.filter((r) => state.selected.has(r.id)).length;
  if ($('selAll')) {
    $('selAll').checked = total > 0 && inList === total;
    $('selAll').indeterminate = inList > 0 && inList < total;
    $('selAll').disabled = total === 0;
  }

  if ($('pgInfo')) $('pgInfo').textContent = total ? `${start + 1}–${start + slice.length} / 총 ${total}건` : '0건';
  if ($('pgNow')) $('pgNow').textContent = `${state.page} / ${pages}`;
  if ($('pgPrev')) $('pgPrev').disabled = state.page <= 1;
  if ($('pgNext')) $('pgNext').disabled = state.page >= pages;
  if ($('btnCsv')) $('btnCsv').disabled = total === 0;
}

/* ---------- 조회 조건 이벤트 ---------- */
$('q')?.addEventListener('input', (e: any) => {
  state.q = e.target.value;
  state.page = 1;
  renderAdmin();
});
$('fSession')?.addEventListener('change', (e: any) => {
  state.session = e.target.value;
  state.page = 1;
  renderAdmin();
});
$('fSort')?.addEventListener('change', (e: any) => {
  state.sort = e.target.value;
  state.page = 1;
  renderAdmin();
});
$('pgSize')?.addEventListener('change', (e: any) => {
  state.size = +e.target.value;
  state.page = 1;
  renderAdmin();
});
$('pgPrev')?.addEventListener('click', () => {
  state.page--;
  renderAdmin();
});
$('pgNext')?.addEventListener('click', () => {
  state.page++;
  renderAdmin();
});
$('selAll')?.addEventListener('change', (e: any) => {
  const { list } = query();
  if (e.target.checked) list.forEach((r) => state.selected.add(r.id));
  else list.forEach((r) => state.selected.delete(r.id));
  renderAdmin();
});
$('selClear')?.addEventListener('click', () => {
  state.selected.clear();
  renderAdmin();
});
$('selDelete')?.addEventListener('click', () =>
  removeRecords(
    Array.from(state.selected),
    '선택한 ' + state.selected.size + '건의 신청서를 삭제할까요? 되돌릴 수 없어요.'
  )
);

/* ---------- 삭제 ---------- */
async function removeRecords(ids: string[], message: string) {
  if (!ids.length) return;
  if (!(await ask(ids.length > 1 ? ids.length + '건 삭제' : '신청서 삭제', message, '삭제'))) return;

  try {
    for (const id of ids) {
      await deleteApplicationFromFirestore(id);
    }
    // Also remove from local cache
    const gone = new Set(ids);
    cloudApplications = cloudApplications.filter((r) => !gone.has(r.id));
    saveLocalBackup(loadLocalBackup().filter((r) => !gone.has(r.id)));
    ids.forEach((id) => state.selected.delete(id));
    popup(ids.length + '건을 삭제했어요.', 'ok');
    renderAdmin();
  } catch (err: any) {
    console.error('Delete error:', err);
    popup('삭제하지 못했습니다: ' + (err.message || '권한을 확인하세요.'));
  }
}

/* ---------- 등록/수정 폼 ---------- */
const edForm = $('edForm') as HTMLFormElement;
const adminEl = (k: string) => (k === 'session' ? edForm.querySelector('input[name="session"]') : $('f-' + k));
bindLimited($('f-name'), NAME_BAD, 10, MSG.nameMax);
bindLimited($('f-org'), ORG_BAD, 50, MSG.orgMax);
bindPhone($('f-phone'), $('aerr-phone'));
$('f-motive')?.addEventListener('input', (e: any) => {
  if ($('acount')) $('acount').textContent = e.target.value.length;
});

function fillEditor(d: Partial<ApplicationRecord>) {
  clearErrors('aerr-', adminEl);
  if ($('f-name')) $('f-name').value = d.name || '';
  if ($('f-email')) $('f-email').value = d.email || '';
  if ($('f-phone')) $('f-phone').value = d.phone || '';
  if ($('f-org')) $('f-org').value = d.org || '';
  edForm?.querySelectorAll('input[name="session"]').forEach((r: any) => {
    r.checked = r.value === d.session;
  });
  if ($('f-motive')) $('f-motive').value = d.motive || '';
  if ($('acount')) $('acount').textContent = (d.motive || '').length;
  if ($('f-agree')) $('f-agree').checked = !!d.agree;
}

function readEditor() {
  const s = edForm.querySelector('input[name="session"]:checked') as HTMLInputElement;
  return {
    name: ($('f-name') as HTMLInputElement).value.trim(),
    email: ($('f-email') as HTMLInputElement).value.trim(),
    phone: ($('f-phone') as HTMLInputElement).value.trim(),
    org: ($('f-org') as HTMLInputElement).value.trim(),
    session: s ? s.value : '',
    motive: ($('f-motive') as HTMLTextAreaElement).value.trim(),
    agree: ($('f-agree') as HTMLInputElement).checked,
  };
}

function openEditor(rec: ApplicationRecord | null) {
  state.editingId = rec ? rec.id : null;
  fillEditor(rec || {});
  if ($('edTitle')) $('edTitle').textContent = rec ? '신청 수정' : '신청 등록';
  if ($('edMeta'))
    $('edMeta').textContent = rec
      ? '접수 ' +
        fmtDateTime(rec.submittedAt) +
        (rec.updatedAt && rec.updatedAt !== rec.submittedAt ? ' · 수정 ' + fmtDateTime(rec.updatedAt) : '')
      : '관리자가 직접 등록합니다.';
  if ($('edSave')) $('edSave').textContent = rec ? '수정 내용 저장' : '등록';
  ($('editor') as HTMLDialogElement).showModal();
  $('f-name')?.focus();
}

$('btnNew')?.addEventListener('click', () => openEditor(null));
$('edCancel')?.addEventListener('click', () => ($('editor') as HTMLDialogElement).close());
edForm?.addEventListener('input', (e: any) => {
  const k = e.target && e.target.name;
  if (k && k !== 'phone' && $('aerr-' + k)) {
    $('aerr-' + k).textContent = '';
    e.target.removeAttribute('aria-invalid');
  }
});

edForm?.addEventListener('submit', async (e: Event) => {
  e.preventDefault();
  const d = readEditor();
  const others = getAllApplications().filter((r) => r.id !== state.editingId);
  const errs = computeErrors(d, ($('f-email') as HTMLInputElement).value, others, '신청자의 개인정보 수집·이용 동의가 필요해요.');
  if (!applyErrors(errs, 'aerr-', adminEl)) return;

  const now = Date.now();
  const isNew = !state.editingId;
  const saveBtn = $('edSave') as HTMLButtonElement;
  saveBtn.disabled = true;

  try {
    if (isNew) {
      const docId = newId();
      const rec: ApplicationRecord = {
        id: docId,
        ...d,
        submittedAt: now,
        updatedAt: now,
      };
      await submitApplicationToFirestore(rec);
      cloudApplications.push(rec);
    } else {
      const editId = state.editingId!;
      await updateApplicationInFirestore(editId, {
        ...d,
        updatedAt: now,
      });
      const idx = cloudApplications.findIndex((r) => r.id === editId);
      if (idx >= 0) {
        cloudApplications[idx] = { ...cloudApplications[idx], ...d, updatedAt: now };
      }
    }
    ($('editor') as HTMLDialogElement).close();
    popup(isNew ? '신청서를 등록했어요.' : '신청 내용을 수정했어요.', 'ok');
    renderAdmin();
  } catch (err: any) {
    console.error('Save error:', err);
    popup('저장하지 못했습니다: ' + (err.message || '권한을 확인하세요.'));
  } finally {
    saveBtn.disabled = false;
  }
});

/* ---------- CSV 내려받기 ---------- */
function csvCell(v: any) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

$('btnCsv')?.addEventListener('click', () => {
  const n = query().list.length;
  if (!n) return;
  if ($('csvMeta')) $('csvMeta').textContent = '현재 조회 결과 ' + n + '건을 내려받습니다.';
  const defaultRadio = $('csvForm')?.querySelector('input[name="csvMask"][value="masked"]') as HTMLInputElement;
  if (defaultRadio) defaultRadio.checked = true;
  ($('csvDlg') as HTMLDialogElement).showModal();
  $('csvOk')?.focus();
});
$('csvCancel')?.addEventListener('click', () => ($('csvDlg') as HTMLDialogElement).close());
$('csvForm')?.addEventListener('submit', (e: Event) => {
  e.preventDefault();
  const formEl = $('csvForm') as HTMLFormElement;
  const masked = (formEl.querySelector('input[name="csvMask"]:checked') as HTMLInputElement).value === 'masked';
  ($('csvDlg') as HTMLDialogElement).close();
  exportCsv(masked);
});

function exportCsv(masked: boolean) {
  const { list } = query();
  const head = ['접수일시', '이름', '이메일', '연락처', '소속', '참가 일정', '신청 동기'];
  const lines = [head.map(csvCell).join(',')].concat(
    list.map((r) =>
      [
        fmtDateTime(r.submittedAt),
        masked ? maskName(r.name) : r.name,
        r.email,
        masked ? maskPhone(r.phone || '') : r.phone || '',
        r.org || '',
        r.session,
        r.motive,
      ]
        .map(csvCell)
        .join(',')
    )
  );
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const t = new Date();
  a.href = url;
  a.download =
    '신청목록_' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + (masked ? '_마스킹' : '_원본') + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  popup(list.length + '건을 내려받았어요. (' + (masked ? '마스킹' : '원본') + ')', 'ok');
}

/* ---------- Google Sheets 연동 ---------- */
let currentSheetSettings: SheetSettings | null = null;

function extractSpreadsheetId(val: string): string {
  const trimmed = val.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return trimmed;
}

function updateSheetUI() {
  if (currentSheetSettings?.spreadsheetId) {
    if ($('sheetsLinkedBox')) $('sheetsLinkedBox').hidden = false;
    if ($('sheetsLinkedUrl')) $('sheetsLinkedUrl').textContent = currentSheetSettings.spreadsheetUrl;
    if ($('sheetsOpenLink')) ($('sheetsOpenLink') as HTMLAnchorElement).href = currentSheetSettings.spreadsheetUrl;
    if ($('customSheetId')) ($('customSheetId') as HTMLInputElement).value = currentSheetSettings.spreadsheetId;
    if ($('autoSyncCheck')) ($('autoSyncCheck') as HTMLInputElement).checked = currentSheetSettings.autoSync !== false;
    if ($('btnSheets')) $('btnSheets').title = 'Google Sheets 연결됨: ' + currentSheetSettings.spreadsheetId;
  } else {
    if ($('sheetsLinkedBox')) $('sheetsLinkedBox').hidden = true;
  }
}

async function initSheetSettings() {
  try {
    currentSheetSettings = await loadSheetSettings();
    updateSheetUI();
  } catch (err) {
    console.warn('Load sheet settings error:', err);
  }
}

// Google Sheets 대화상자 열기
$('btnSheets')?.addEventListener('click', async () => {
  const token = getAccessToken();
  if (!token) {
    popup('Google Sheets를 연동하려면 Google 계정 로그인이 필요합니다.');
    const gateBtn = $('btnGoogleLogin');
    if (gateBtn) {
      gateBtn.scrollIntoView({ behavior: 'smooth' });
    }
    return;
  }
  await initSheetSettings();
  ($('sheetsDlg') as HTMLDialogElement).showModal();
});

$('sheetsCancel')?.addEventListener('click', () => ($('sheetsDlg') as HTMLDialogElement).close());

// 새 스프레드시트 생성 버튼
$('sheetsCreateBtn')?.addEventListener('click', async () => {
  const token = getAccessToken();
  if (!token) {
    popup('Google 계정 인증이 필요합니다.');
    return;
  }

  // 필수 사용자 확인 다이얼로그 (Workspace 데이터 생성 전 확인)
  if (!(await ask('Google Sheets 생성', '내 Google Drive에 새 스프레드시트를 생성하고 기존 신청자 목록을 동기화할까요?', '생성 및 동기화'))) {
    return;
  }

  const btn = $('sheetsCreateBtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '생성 중...';

  try {
    const { spreadsheetId, spreadsheetUrl } = await createParticipantSpreadsheet('참가 신청자 명단 (자동 연동)');
    const allApps = getAllApplications();
    const syncRes = await syncApplicationsToSheet(spreadsheetId, allApps);

    currentSheetSettings = {
      spreadsheetId,
      spreadsheetUrl,
      autoSync: ($('autoSyncCheck') as HTMLInputElement)?.checked ?? true,
      updatedAt: Date.now(),
    };
    await saveSheetSettings(currentSheetSettings);
    updateSheetUI();

    popup(`Google Sheets에 ${syncRes.addedCount}건의 신청자 데이터가 동기화되었습니다!`, 'ok');
  } catch (err: any) {
    console.error('Create sheet error:', err);
    popup('스프레드시트 생성에 실패했습니다: ' + (err.message || '인증을 확인하세요.'));
  } finally {
    btn.disabled = false;
    btn.textContent = '새 스프레드시트 생성';
  }
});

// 스프레드시트 동기화 폼 제출
$('sheetsForm')?.addEventListener('submit', async (e: Event) => {
  e.preventDefault();
  const token = getAccessToken();
  if (!token) {
    popup('Google 계정 인증이 필요합니다.');
    return;
  }

  const inputVal = ($('customSheetId') as HTMLInputElement)?.value || '';
  let targetId = extractSpreadsheetId(inputVal);

  if (!targetId && currentSheetSettings?.spreadsheetId) {
    targetId = currentSheetSettings.spreadsheetId;
  }

  if (!targetId) {
    popup('스프레드시트 ID 또는 URL을 입력하거나, [새 스프레드시트 생성]을 클릭하세요.');
    return;
  }

  // 필수 사용자 확인 다이얼로그 (Workspace 데이터 동기화 전 확인)
  if (!(await ask('Google Sheets 동기화', '선택한 Google Sheets 스프레드시트에 신청자 데이터를 동기화할까요?', '동기화'))) {
    return;
  }

  const syncBtn = $('sheetsSyncBtn') as HTMLButtonElement;
  syncBtn.disabled = true;
  syncBtn.textContent = '동기화 중...';

  try {
    const allApps = getAllApplications();
    const syncRes = await syncApplicationsToSheet(targetId, allApps);

    currentSheetSettings = {
      spreadsheetId: targetId,
      spreadsheetUrl: syncRes.spreadsheetUrl,
      autoSync: ($('autoSyncCheck') as HTMLInputElement)?.checked ?? true,
      updatedAt: Date.now(),
    };
    await saveSheetSettings(currentSheetSettings);
    updateSheetUI();

    popup(`Google Sheets 동기화 완료: ${syncRes.addedCount}건이 시트에 추가되었습니다.`, 'ok');
  } catch (err: any) {
    console.error('Sync sheet error:', err);
    popup('동기화 실패: ' + (err.message || '시트 접근 권한을 확인하세요.'));
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = '신청자 데이터 동기화';
  }
});

/* =====================================================
   화면 전환 (#admin ↔ 신청서) & 인증
   ===================================================== */
const ADMIN_SALT = 'participant-admin:v1';
const ADMIN_HASH = '2eb1f343f6ec310d8d8a3860688106f20ae8679bd7f64fdff6adb7c34cd711e7';
const AUTH_KEY = 'participant-admin-auth:v1';
const MAX_FAILS = 5;
const LOCK_SEC = 30;
let authMemory = false;
let fails = 0;
let lockTimer: any = null;

function isAuthed(): boolean {
  if (currentAdminUser && (currentAdminUser.email === ADMIN_EMAIL || currentAdminUser.emailVerified)) {
    return true;
  }
  if (authMemory) return true;
  try {
    return sessionStorage.getItem(AUTH_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function setAuthed(on: boolean) {
  authMemory = on;
  try {
    if (on) sessionStorage.setItem(AUTH_KEY, '1');
    else sessionStorage.removeItem(AUTH_KEY);
  } catch (_) {}
}

async function hashPassword(pw: string): Promise<string> {
  if (!(window.crypto && crypto.subtle)) throw new Error('no-subtle');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(ADMIN_SALT), iterations: 100000 },
    key,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function startLock() {
  let left = LOCK_SEC;
  if ($('gatePw')) $('gatePw').disabled = true;
  if ($('gateBtn')) $('gateBtn').disabled = true;
  const tick = () => {
    if (left <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      if ($('gatePw')) $('gatePw').disabled = false;
      if ($('gateBtn')) $('gateBtn').disabled = false;
      if ($('gateErr')) $('gateErr').textContent = '';
      return;
    }
    if ($('gateErr'))
      $('gateErr').textContent = '비밀번호를 ' + MAX_FAILS + '번 틀렸어요. ' + left + '초 뒤에 다시 시도하세요.';
    left--;
  };
  clearInterval(lockTimer);
  tick();
  lockTimer = setInterval(tick, 1000);
}

// Google 로그인 버튼 이벤트
$('btnGoogleLogin')?.addEventListener('click', async () => {
  const btn = $('btnGoogleLogin') as HTMLButtonElement;
  btn.disabled = true;
  if ($('gateErr')) $('gateErr').textContent = '';
  const popupAlert = $('popupBlockedAlert');
  if (popupAlert) popupAlert.style.display = 'none';

  try {
    const { user } = await signInAdminWithGoogle();
    popup(`관리자(${user.email})로 인증되었습니다.`, 'ok');
    setAuthed(true);
    route();
  } catch (err: any) {
    console.error('Google sign-in error:', err);
    const isPopupBlocked =
      err?.code === 'auth/popup-blocked' ||
      (typeof err?.message === 'string' && err.message.toLowerCase().includes('popup-blocked')) ||
      (typeof err?.message === 'string' && err.message.toLowerCase().includes('popup blocked'));

    if (isPopupBlocked) {
      if (popupAlert) {
        popupAlert.style.display = 'block';
      }
      if ($('gateErr')) {
        $('gateErr').textContent = '브라우저에서 Google 로그인 팝업 창이 차단되었습니다. 위의 안내를 확인해 주세요.';
      }
    } else {
      if ($('gateErr')) {
        $('gateErr').textContent =
          'Google 로그인 실패: ' + (err.message || '인증이 취소되었거나 오류가 발생했습니다.');
      }
    }
  } finally {
    btn.disabled = false;
  }
});

// Google 페이지 이동(리디렉션) 로그인 버튼 이벤트
$('btnGoogleRedirect')?.addEventListener('click', async () => {
  const btn = $('btnGoogleRedirect') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '로그인 이동 중...';
  if ($('gateErr')) $('gateErr').textContent = '';

  try {
    // iframe 내부인 경우 accounts.google.com X-Frame-Options 정책으로 인해 iframe 내 redirect 불가
    if (window.self !== window.top) {
      window.open(window.location.origin + '/admin', '_blank');
      if ($('gateErr')) {
        $('gateErr').textContent = '새 탭이 열렸습니다. 새 탭에서 구글 로그인을 진행해 주세요.';
      }
      return;
    }
    await signInAdminWithRedirect();
  } catch (err: any) {
    console.error('Google redirect sign-in error:', err);
    if ($('gateErr')) {
      $('gateErr').textContent = '리디렉션 로그인 실패: ' + (err.message || String(err));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '페이지 이동으로 로그인';
  }
});

// 비밀번호 폼 이벤트
$('gateForm')?.addEventListener('submit', async (e: Event) => {
  e.preventDefault();
  if (lockTimer) return;
  const pw = ($('gatePw') as HTMLInputElement).value;
  if (!pw) {
    if ($('gateErr')) $('gateErr').textContent = '비밀번호를 입력하세요.';
    $('gatePw')?.focus();
    return;
  }
  const gateBtn = $('gateBtn') as HTMLButtonElement;
  gateBtn.disabled = true;
  let ok = false;
  try {
    ok = (await hashPassword(pw)) === ADMIN_HASH;
  } catch (_) {
    if ($('gateErr')) $('gateErr').textContent = '이 환경에서는 비밀번호를 확인할 수 없어요. HTTPS 주소로 열어 주세요.';
    gateBtn.disabled = false;
    return;
  }
  if ($('gatePw')) $('gatePw').value = '';
  if (ok) {
    fails = 0;
    if ($('gateErr')) $('gateErr').textContent = '';
    gateBtn.disabled = false;
    setAuthed(true);
    route();
    return;
  }
  fails++;
  if (fails >= MAX_FAILS) {
    fails = 0;
    startLock();
    return;
  }
  if ($('gateErr')) $('gateErr').textContent = '비밀번호가 올바르지 않아요. (' + fails + '/' + MAX_FAILS + ')';
  gateBtn.disabled = false;
  $('gatePw')?.focus();
});

// SPA 내비게이션 헬퍼 (새로고침 없이 깔끔한 URL 변경)
function navigate(path: string) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
  route();
}

// 링크 클릭 가로채기
document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement)?.closest('a');
  if (target) {
    const href = target.getAttribute('href');
    if (href === '/' || href === '/admin') {
      e.preventDefault();
      navigate(href);
    }
  }
});

// 로그아웃 버튼 이벤트
$('btnLogout')?.addEventListener('click', async () => {
  try {
    await signOutAdmin();
  } catch (_) {}
  setAuthed(false);
  state.selected.clear();
  if (firestoreUnsub) {
    firestoreUnsub();
    firestoreUnsub = null;
  }
  navigate('/');
});

const isAdminRoute = () => {
  const p = window.location.pathname;
  return p === '/admin' || p.startsWith('/admin/') || window.location.hash === '#admin';
};

function startFirestoreSync() {
  if (firestoreUnsub) return;
  try {
    firestoreUnsub = subscribeToApplications(
      (records) => {
        cloudApplications = records;
        saveLocalBackup(records);
        renderAdmin();
        if (currentSheetSettings?.spreadsheetId && currentSheetSettings.autoSync && getAccessToken()) {
          syncApplicationsToSheet(currentSheetSettings.spreadsheetId, records).catch((e) => {
            console.warn('Google Sheets auto-sync notice:', e);
          });
        }
      },
      (err) => {
        console.warn('Real-time sync notice:', err);
      }
    );
  } catch (e) {
    console.warn('Could not subscribe:', e);
  }
}

function route() {
  // 해시 기반 이전 URL이 남아있는 경우 경로 URL로 정규화
  if (window.location.hash === '#admin') {
    window.history.replaceState({}, '', '/admin');
  } else if (window.location.hash === '#apply') {
    window.history.replaceState({}, '', '/');
  }

  const admin = isAdminRoute();
  const authed = admin && isAuthed();
  if ($('applyView')) $('applyView').hidden = admin;
  if ($('gateView')) $('gateView').hidden = !(admin && !authed);
  if ($('adminView')) $('adminView').hidden = !authed;

  document.title = !admin ? '참가 신청서' : authed ? '신청 관리 · 관리자' : '관리자 확인';

  if (authed) {
    initSheetSettings();
    startFirestoreSync();
    renderAdmin();
  } else {
    if (firestoreUnsub) {
      firestoreUnsub();
      firestoreUnsub = null;
    }
    if (admin) {
      setTimeout(() => {
        try {
          if ($('gatePw') && !$('gatePw').disabled) $('gatePw').focus();
        } catch (_) {}
      }, 0);
    }
  }
  try {
    window.scrollTo(0, 0);
  } catch (_) {}
}

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);

// Listen to Firebase Auth state
onAdminAuthChanged((user) => {
  currentAdminUser = user;
  if (user) {
    if (user.email === ADMIN_EMAIL || user.emailVerified) {
      setAuthed(true);
      if (isAdminRoute()) {
        route();
      }
    }
  }
});

if (!probeStorage()) {
  useMemory = true;
  showNotice('이 브라우저에서는 로컬 저장소를 쓸 수 없어 Firestore 클라우드 저장소를 직접 사용합니다.', false);
}

// Check redirect login result on boot
checkRedirectResult()
  .then((res) => {
    if (res?.user) {
      popup(`관리자(${res.user.email})로 인증되었습니다.`, 'ok');
      setAuthed(true);
      if (isAdminRoute()) {
        route();
      }
    }
  })
  .catch((err) => {
    console.warn('Redirect auth check warning:', err);
  });

// Initial route
route();


