// Google ドライブ連携(Web版のみ)
// - ドライブの「アプリで開く」から起動されたとき、選ばれたPDFをドライブから直接読み込む
// - 編集結果を、元のPDFと同じフォルダに新しいファイルとして保存する
// PDFは「ドライブ ⇔ このブラウザ」の間で直接やり取りし、ほかのサーバーは通さない。
// 権限は drive.file(このアプリで開いた・作ったファイルだけを扱える最小の権限)のみを使う。

// Google Cloud で作成した OAuth クライアントID。空のあいだはドライブ連携を表示しない。
// クライアントIDは秘密情報ではない(ページを開けば誰でも見られる値)ので、ここに書いてよい。
export const DRIVE_CLIENT_ID = '933497434046-osuvtsa9ao38evdjgn15nm6sstbtgrnn.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const GIS_URL = 'https://accounts.google.com/gsi/client';

// 拡張機能版ではGoogleのスクリプトを読み込めない(CSPで禁止)ので、Web版でだけ使う
export const driveEnabled = /^https?:$/.test(location.protocol) && DRIVE_CLIENT_ID !== '';

// ドライブの「アプリで開く」は ?state={"ids":[...],"action":"open","userId":"..."} を付けてこのページを開く
export function readOpenRequest() {
  const raw = new URLSearchParams(location.search).get('state');
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (state.action === 'open' && Array.isArray(state.ids) && state.ids.length) {
      return { ids: state.ids, userId: state.userId };
    }
  } catch {
    // 形式が違うものは無視する
  }
  return null;
}

// ---- Googleログイン(アクセストークンの取得) ----
// ログイン画面はポップアップで開くため、ボタンを押した直後に呼ぶ必要がある(遅れるとブロックされる)。
// そのためGoogleのスクリプトはページを開いた時点で先に読み込んでおく。
let gisReady = null;
let tokenClient = null;
let token = null;
let tokenExpiresAt = 0;
let pending = null;

export function preloadGoogleLogin() {
  if (!driveEnabled || gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Googleログインの読み込みに失敗しました。ネットワークを確認してください。'));
    document.head.appendChild(script);
  });
  return gisReady;
}

async function getToken(loginHint) {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  await preloadGoogleLogin();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID,
      scope: SCOPE,
      login_hint: loginHint,
      callback: (res) => {
        if (res.error) return pending?.reject(new Error(res.error_description || res.error));
        token = res.access_token;
        tokenExpiresAt = Date.now() + Number(res.expires_in) * 1000;
        pending?.resolve(token);
      },
      error_callback: (err) => {
        const message = err?.type === 'popup_closed'
          ? 'Googleのログイン画面が閉じられました。'
          : 'Googleのログイン画面を開けませんでした。ポップアップがブロックされていないか確認してください。';
        pending?.reject(new Error(message));
      },
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function call(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) token = null; // 期限切れ。次の操作でログインし直す
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(driveErrorMessage(res.status, detail?.error?.message));
  }
  return res;
}

function driveErrorMessage(status, detail) {
  if (status === 401) return 'Googleのログインの有効期限が切れました。もう一度操作してください。';
  if (status === 403) return 'このファイル(またはフォルダ)を扱う権限がありません。';
  if (status === 404) return 'ファイルが見つかりません。削除されたか、権限がない可能性があります。';
  return `Googleドライブとの通信に失敗しました(${status})。${detail ?? ''}`;
}

// ---- 読み込み ----
// 戻り値の File には .drive = { id, name, parents } を付ける(保存先のフォルダを覚えておくため)
export async function openFromDrive(ids, loginHint) {
  await getToken(loginHint);
  const files = [];
  for (const id of ids) {
    const q = 'supportsAllDrives=true';
    const meta = await (await call(`${API}/${encodeURIComponent(id)}?fields=id,name,mimeType,parents&${q}`)).json();
    if (meta.mimeType !== 'application/pdf') throw new Error(`「${meta.name}」はPDFではありません。`);
    const blob = await (await call(`${API}/${encodeURIComponent(id)}?alt=media&${q}`)).blob();
    const file = new File([blob], meta.name, { type: 'application/pdf' });
    file.drive = { id: meta.id, name: meta.name, parents: meta.parents ?? [] };
    files.push(file);
  }
  return files;
}

// ---- 保存 ----
// 元のPDFと同じフォルダに、新しいファイルとして保存する(元のファイルは上書きしない)
export async function saveToDrive(bytes, name, parentId, loginHint) {
  await getToken(loginHint);
  const boundary = 'pdf-page-editor-' + Math.random().toString(36).slice(2);
  const metadata = { name, mimeType: 'application/pdf', ...(parentId ? { parents: [parentId] } : {}) };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await call(`${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json(); // { id, name, webViewLink }
}
