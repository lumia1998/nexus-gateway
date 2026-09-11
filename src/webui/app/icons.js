const svg = (inner, cls) => '<svg viewBox="0 0 24 24"' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true" focusable="false">' + inner + '</svg>'

export const icons = {
  search: svg('<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>'),
  refresh: svg('<path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>'),
  plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  copy: svg('<rect x="9" y="9" width="10" height="10" rx="2"/><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>'),
  disable: svg('<circle cx="12" cy="12" r="8"/><path d="m6.3 6.3 11.4 11.4"/>'),
  enable: svg('<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.3 2.3 4.8-5"/>'),
  edit: svg('<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  reveal: svg('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>'),
  scope: svg('<path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6Z"/><path d="M9.5 12 11 13.5l3.5-4"/>'),
  regenerate: svg('<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.1a2 2 0 0 1-1.66-.89l-.75-1.12A2 2 0 0 0 8.83 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/>'),
  robot: svg('<path d="M12 8V4.5"/><circle cx="12" cy="3" r="1.1"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9.5 13v1.6"/><path d="M14.5 13v1.6"/><path d="M9.5 17.2h5"/>'),
  activity: svg('<path d="M22 12h-2.5a2 2 0 0 0-1.93 1.46l-2.1 7.4a.25.25 0 0 1-.48 0L9.24 3.14a.25.25 0 0 0-.48 0l-2.1 7.4A2 2 0 0 1 4.73 12H2"/>'),
  artifacts: svg('<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  file: svg('<path d="M15.75 13a.75.75 0 0 0-.75-.75H9a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 .75-.75m0 4a.75.75 0 0 0-.75-.75H9a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 .75-.75"/><path fill-rule="evenodd" d="M7 2.25A2.75 2.75 0 0 0 4.25 5v14A2.75 2.75 0 0 0 7 21.75h10A2.75 2.75 0 0 0 19.75 19V7.968c0-.381-.124-.751-.354-1.055l-2.998-3.968a1.75 1.75 0 0 0-1.396-.695zM5.75 5c0-.69.56-1.25 1.25-1.25h7.25v4.397c0 .414.336.75.75.75h3.25V19c0 .69-.56 1.25-1.25 1.25H7c-.69 0-1.25-.56-1.25-1.25z" clip-rule="evenodd"/>', 'filled'),
  image: svg('<path d="M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><circle cx="8.5" cy="8.5" r="2.5"/><path d="M14.526 12.621 6 22h12.133A3.867 3.867 0 0 0 22 18.133V18c0-.466-.175-.645-.49-.99l-4.03-4.395a2 2 0 0 0-2.954.006"/>'),
  fileText: svg('<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2"/><path d="M9 9h1"/><path d="M9 13h6"/><path d="M9 17h6"/>'),
  filePlay: svg('<rect width="20" height="16" x="2" y="4" rx="4"/><path d="m15 12-5-3v6z"/>'),
  fileAudio: svg('<path d="M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><path d="M9 16.5V8.78a1 1 0 0 1 .757-.97l6-1.5A1 1 0 0 1 17 7.28V15"/><path d="m9 11 8-2"/><circle cx="7.5" cy="16.5" r="1.5"/><circle cx="15.5" cy="15.5" r="1.5"/>'),
  fileCode: svg('<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2"/><path d="m10 13-1 2 1 2"/><path d="m14 13 1 2-1 2"/>'),
  key: svg('<circle cx="8" cy="15" r="4.2"/><path d="m11.1 12 8-8"/><path d="m15.4 7.7 2.9 2.9"/><path d="m17.6 5.5 2.9 2.9"/>')
}

