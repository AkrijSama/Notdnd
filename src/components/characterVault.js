import { parseList, titleCase } from "../utils/helpers.js";

export function renderCharacterVault(state) {
  return `
    <section class="module-card">
      <div class="module-header">
        <h2>Character Vault</h2>
        <span class="tag">Builder + sheet + token link</span>
      </div>

      <div class="grid-two">
        <form id="character-form" class="module-card">
          <h3>Create Character</h3>
          <label class="field"><span>Name</span><input name="name" required placeholder="Lyra Dawnveil" /></label>
          <label class="field"><span>Class</span><input name="className" required placeholder="Bard" /></label>
          <div class="grid-three">
            <label class="field"><span>Level</span><input name="level" type="number" min="1" max="20" value="1" required /></label>
            <label class="field"><span>AC</span><input name="ac" type="number" min="5" max="30" value="12" required /></label>
            <label class="field"><span>HP</span><input name="hp" type="number" min="1" max="400" value="10" required /></label>
          </div>
          <label class="field"><span>Spells</span><input name="spells" placeholder="Vicious Mockery, Healing Word" /></label>
          <label class="field"><span>Inventory</span><input name="inventory" placeholder="Lute, Rapier, Potion" /></label>
          <button type="submit">Save Character</button>
        </form>

        <article class="module-card">
          <h3>Party Sheets</h3>
          <ul class="list">
            ${state.characters
              .map(
                (character) => `
                  <li class="list-item">
                    <div class="inline"><strong>${character.name}</strong> <span class="tag">Lv ${character.level} ${character.className}</span></div>
                    <div class="small">AC ${character.ac} | HP ${character.hp} | Speed ${character.speed || 30}</div>
                    <div class="small">Spells: ${(character.spells || []).join(", ") || "None"}</div>
                    <div class="small">Inventory: ${(character.inventory || []).join(", ") || "None"}</div>
                  </li>
                `
              )
              .join("")}
          </ul>
        </article>
      </div>
    </section>
  `;
}

export function bindCharacterVault(root, store) {
  const form = root.querySelector("#character-form");
  if (!form) {
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = new FormData(form);
    const character = {
      name: titleCase(payload.get("name")),
      className: titleCase(payload.get("className")),
      level: Number(payload.get("level")) || 1,
      ac: Number(payload.get("ac")) || 10,
      hp: Number(payload.get("hp")) || 8,
      speed: 30,
      spells: parseList(payload.get("spells")),
      inventory: parseList(payload.get("inventory")),
      stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiencies: []
    };

    store.addCharacter(character);
    store.pushChatLine({ speaker: "System", text: `${character.name} added to the shared vault.` });
    form.reset();
  });
}
