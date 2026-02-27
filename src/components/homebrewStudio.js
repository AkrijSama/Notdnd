import { parseList, titleCase } from "../utils/helpers.js";

function parseChaptersFromText(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function renderHomebrewStudio(state) {
  const homebrew = state.books.filter((book) => book.type !== "Official");

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>Homebrew Studio</h2>
        <span class="tag">Drop books -> auto-campaign scaffolding</span>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>Ingest Homebrew Source</h3>
          <p class="small">Supports placeholder ingest of txt/md/json exports. Each ingest creates compendium records usable in campaign forge.</p>

          <div class="field">
            <span>Upload Files</span>
            <input id="book-files" type="file" multiple accept=".txt,.md,.json" />
          </div>

          <form id="homebrew-url-form" class="field">
            <span>Import From URL</span>
            <input name="url" type="url" placeholder="https://example.com/homebrew.md" required />
            <button type="submit" class="ghost">Fetch & Parse URL</button>
            <div class="small" id="homebrew-url-status">Fetch remote markdown/json/txt homebrew and ingest extracted books.</div>
          </form>

          <form id="homebrew-form" class="field">
            <span>Or Add Manual Book</span>
            <input name="title" placeholder="Chronicles of Iron Reef" required />
            <input name="tags" placeholder="nautical, monsters, subclasses" />
            <textarea name="chapters" placeholder="Chapter One, Chapter Two, Chapter Three"></textarea>
            <button type="submit">Add Homebrew Book</button>
          </form>
        </article>

        <article class="module-card">
          <h3>Imported Homebrew Library</h3>
          <ul class="list">
            ${homebrew.length === 0 ? `<li class="list-item">No homebrew imported yet.</li>` : ""}
            ${homebrew
              .map(
                (book) => `
                  <li class="list-item">
                    <div class="inline"><strong>${book.title}</strong> <span class="tag">${book.type}</span></div>
                    <div>${(book.tags || []).map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
                    <div class="small">Chapters: ${(book.chapters || []).join(", ") || "None"}</div>
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

export function bindHomebrewStudio(root, store) {
  const form = root.querySelector("#homebrew-form");
  const filesInput = root.querySelector("#book-files");
  const urlForm = root.querySelector("#homebrew-url-form");
  const urlStatus = root.querySelector("#homebrew-url-status");

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(form);
      const title = titleCase(payload.get("title"));
      const tags = parseList(payload.get("tags"));
      const chapters = parseList(payload.get("chapters"));
      const created = store.addBook({
        title,
        type: "Homebrew",
        tags,
        chapters
      });
      store.pushChatLine({ speaker: "System", text: `Homebrew book indexed: ${created.title}.` });
      form.reset();
    });
  }

  if (filesInput) {
    filesInput.addEventListener("change", async () => {
      const files = Array.from(filesInput.files || []);
      for (const file of files) {
        const text = await file.text();
        const chapters = parseChaptersFromText(text);
        const fallbackChapters = chapters.length > 0 ? chapters : ["Overview", "Rules", "Creatures", "Adventure Hooks"];
        const baseTitle = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
        const created = store.addBook({
          title: titleCase(baseTitle),
          type: "Homebrew",
          tags: ["imported", "homebrew"],
          chapters: fallbackChapters
        });
        store.pushChatLine({ speaker: "System", text: `Imported ${file.name} as ${created.title}.` });
      }
      filesInput.value = "";
    });
  }

  if (urlForm) {
    urlForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(urlForm);
      const url = String(payload.get("url") || "").trim();
      if (!url) {
        return;
      }

      if (urlStatus) {
        urlStatus.textContent = "Fetching remote homebrew...";
      }

      try {
        const response = await store.importHomebrewFromUrl(url);
        const parsed = response.parsed || {};
        const books = parsed.books || [];
        for (const book of books) {
          const created = store.addBook({
            title: titleCase(book.title),
            type: "Homebrew",
            tags: book.tags || ["imported", "homebrew", "url"],
            chapters: book.chapters || []
          });
          store.pushChatLine({ speaker: "System", text: `URL import indexed: ${created.title}.` });
        }

        const summary = parsed.summary || {};
        if (urlStatus) {
          urlStatus.textContent = `Imported ${books.length} book(s) from URL. Extracted ${summary.monsters || 0} monsters and ${summary.spells || 0} spells.`;
        }
      } catch (error) {
        if (urlStatus) {
          urlStatus.textContent = `URL import failed: ${String(error.message || error)}`;
        }
      }
    });
  }
}
