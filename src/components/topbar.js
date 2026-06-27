export function renderTopbar(activeTab, user, accountMenuOpen = false) {
  const tabs = [
    ["command", "Command Center"],
    ["forge", "Campaign Forge"],
    ["vtt", "VTT Table"],
    ["characters", "Character Vault"],
    ["compendium", "Compendium"],
    ["homebrew", "Homebrew Studio"],
    ["ai", "AI GM Console"]
  ];

  return `
    <header class="topbar">
      <div class="brand">
        <h1>Inkborne</h1>
        <span>Roll20 + D&D Beyond + AI GM</span>
      </div>
      <nav class="nav-tabs">
        ${tabs
          .map(
            ([id, label]) =>
              `<button class="nav-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`
          )
          .join("")}
      </nav>
      <div class="inline">
        <span class="small">${user ? `Signed in: ${user.displayName}` : "Not signed in"}</span>
        ${
          user
            ? `
              <div class="account-menu">
                <button class="ghost" data-action="toggle-account-menu" aria-haspopup="true" aria-expanded="${accountMenuOpen ? "true" : "false"}">Account ▾</button>
                ${
                  accountMenuOpen
                    ? `
                      <div class="account-dropdown" role="menu">
                        <button class="account-dropdown-item" role="menuitem" data-action="open-account">Account Settings</button>
                        <button class="account-dropdown-item" role="menuitem" data-action="logout">Sign Out</button>
                      </div>
                    `
                    : ""
                }
              </div>
            `
            : `<button class="ghost" data-action="toggle-auth">Sign In</button>`
        }
      </div>
    </header>
  `;
}
