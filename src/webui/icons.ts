const base = (paths: string) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`

export const icons = {
    overview: base(
        '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'
    ),
    runs: base(
        '<path d="M22 12h-2.5a2 2 0 0 0-1.93 1.46l-2.1 7.4a.25.25 0 0 1-.48 0L9.24 3.14a.25.25 0 0 0-.48 0l-2.1 7.4A2 2 0 0 1 4.73 12H2"/>'
    ),
    agents: base(
        '<path d="M12 8V4.5"/><circle cx="12" cy="3" r="1.1"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9.5 13v1.6"/><path d="M14.5 13v1.6"/><path d="M9.5 17.2h5"/>'
    ),
    workspaces: base(
        '<path d="M20 20a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.1a2 2 0 0 1-1.66-.89l-.75-1.12A2 2 0 0 0 8.83 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/>'
    ),
    keys: base(
        '<circle cx="8" cy="15" r="4.2"/><path d="m11.1 12 8-8"/><path d="m15.4 7.7 2.9 2.9"/><path d="m17.6 5.5 2.9 2.9"/>'
    ),
    settings: base(
        '<path d="M21 5h-7"/><path d="M10 5H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 19h-5"/><path d="M12 19H3"/><path d="M12 3v4"/><path d="M8 10v4"/><path d="M16 17v4"/>'
    ),
    sessions: base(
        '<path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z"/><path d="m6.1 10.4-3.5 1.6a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8l-3.5-1.6"/><path d="m6.1 15.4-3.5 1.6a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8l-3.5-1.6"/>'
    ),
    gateway: base(
        '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01"/><path d="M6 17.5h.01"/><path d="M10 6.5h5"/><path d="M10 17.5h5"/>'
    ),
    refresh: base(
        '<path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>'
    ),
    plus: base('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    sun: base(
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'
    ),
    moon: base('<path d="M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    monitor: base(
        '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'
    ),
    menu: base('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
    chevronRight: base('<path d="m9 18 6-6-6-6"/>'),
    close: base('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    logout: base(
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'
    ),
    lock: base('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    inbox: base(
        '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1Z"/>'
    ),
    shield: base(
        '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.66 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>'
    ),
    check: base('<path d="M20 6 9 17l-5-5"/>'),
    alert: base(
        '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
    ),
    search: base('<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>')
}
