// ツールバーのアイコンをクリックしたら編集画面を新しいタブで開く
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});
