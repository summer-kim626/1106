import { getAccessToken, db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { ApplicationRecord } from './firebase';

export interface SheetSettings {
  spreadsheetId: string;
  spreadsheetUrl: string;
  autoSync: boolean;
  updatedAt: number;
}

const HEADERS = ['접수일시', '이름', '이메일', '연락처', '소속', '참가 일정', '신청 동기'];

const pad = (n: number) => String(n).padStart(2, '0');
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

export async function createParticipantSpreadsheet(title = '참가 신청자 명단 (자동 연동)'): Promise<{
  spreadsheetId: string;
  spreadsheetUrl: string;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Google 계정 인증 토큰이 필요합니다. 관리자 로그인을 다시 진행해 주세요.');
  }

  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title,
      },
      sheets: [
        {
          properties: {
            title: '신청자 목록',
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Sheets 생성 실패 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // Write header row with formatting
  await appendRows(spreadsheetId, [HEADERS]);

  return { spreadsheetId, spreadsheetUrl };
}

export async function appendRows(spreadsheetId: string, rows: (string | number)[][]): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Google Sheets 접근 권한이 없습니다. 다시 로그인해 주세요.');
  }

  if (rows.length === 0) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      range: 'A1',
      majorDimension: 'ROWS',
      values: rows,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Sheets 데이터 추가 실패 (${response.status}): ${errorBody}`);
  }
}

export async function getExistingSheetValues(spreadsheetId: string): Promise<string[][]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Google 계정 인증이 필요합니다.');
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:G`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return data.values || [];
}

export async function syncApplicationsToSheet(
  spreadsheetId: string,
  applications: ApplicationRecord[]
): Promise<{ addedCount: number; totalCount: number; spreadsheetUrl: string }> {
  const existingValues = await getExistingSheetValues(spreadsheetId);
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // If sheet is completely empty, insert header
  if (existingValues.length === 0) {
    await appendRows(spreadsheetId, [HEADERS]);
  }

  // Build a set of existing entries based on (email + session or email + submitted date)
  const existingKeys = new Set<string>();
  existingValues.forEach((row, idx) => {
    if (idx === 0) return; // skip header
    const email = (row[2] || '').trim().toLowerCase();
    const dateStr = (row[0] || '').trim();
    if (email) {
      existingKeys.add(`${email}_${dateStr}`);
    }
  });

  const rowsToAppend: (string | number)[][] = [];
  applications.forEach((app) => {
    const formattedDate = fmtDateTime(app.submittedAt);
    const key = `${(app.email || '').trim().toLowerCase()}_${formattedDate}`;
    if (!existingKeys.has(key)) {
      rowsToAppend.push([
        formattedDate,
        app.name || '',
        app.email || '',
        app.phone || '',
        app.org || '',
        app.session || '',
        app.motive || '',
      ]);
    }
  });

  if (rowsToAppend.length > 0) {
    await appendRows(spreadsheetId, rowsToAppend);
  }

  return {
    addedCount: rowsToAppend.length,
    totalCount: applications.length,
    spreadsheetUrl,
  };
}

export async function saveSheetSettings(settings: SheetSettings): Promise<void> {
  try {
    await setDoc(doc(db, 'settings', 'sheets'), settings);
  } catch (err) {
    console.warn('Could not save sheet settings to Firestore:', err);
  }
}

export async function loadSheetSettings(): Promise<SheetSettings | null> {
  try {
    const snap = await getDoc(doc(db, 'settings', 'sheets'));
    if (snap.exists()) {
      return snap.data() as SheetSettings;
    }
  } catch (err) {
    console.warn('Could not load sheet settings from Firestore:', err);
  }
  return null;
}
