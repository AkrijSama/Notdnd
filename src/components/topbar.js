export function renderTopbar(activeTab) {
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
        <h1>Notdnd</h1>
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
    </header>
  `;
}
