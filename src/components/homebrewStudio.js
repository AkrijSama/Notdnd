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
            <div class="small" id="homebrew-file-status">Parse local homebrew files into books and quickstart-ready indexes.</div>
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

      <article class="module-card">
        <h3>Import Sourcebook PDF <span class="tag">beta</span></h3>
        <p class="small">Upload an official or homebrew D&amp;D PDF — or paste a section of its text — and we'll extract races, subclasses, backgrounds, and feats for you to <strong>review and edit before saving</strong>. Parsing is imperfect; scanned or image-only PDFs won't extract — paste the text instead.</p>
        <div class="field">
          <span>Upload PDF</span>
          <input id="hb-pdf-file" type="file" accept=".pdf,application/pdf" />
        </div>
        <div class="field">
          <span>…or paste book text</span>
          <textarea id="hb-pdf-text" rows="4" placeholder="Paste a chapter — e.g. just the races or subclasses section — for the most reliable results."></textarea>
          <button id="hb-pdf-parse" type="button">Parse for character options</button>
          <div class="small" id="hb-pdf-status">Choose a PDF or paste some text, then parse.</div>
        </div>
        <div id="hb-pdf-review"></div>
      </article>
    </section>
  `;
}

export function bindHomebrewStudio(root, store) {
  const form = root.querySelector("#homebrew-form");
  const filesInput = root.querySelector("#book-files");
  const filesStatus = root.querySelector("#homebrew-file-status");
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
      if (files.length === 0) {
        return;
      }
      if (filesStatus) {
        filesStatus.textContent = "Parsing local homebrew files...";
      }
      try {
        const serialized = await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            content: await file.text()
          }))
        );
        const response = await store.parseQuickstartFiles({ files: serialized });
        const parsed = response.parsed || {};
        const books = parsed.books || [];
        for (const book of books) {
          const created = store.addBook({
            title: titleCase(book.title),
            type: "Homebrew",
            tags: book.tags || ["imported", "homebrew"],
            chapters: book.chapters || parseChaptersFromText(book.title)
          });
          store.pushChatLine({ speaker: "System", text: `Imported ${created.title} from local file parse.` });
        }
        if (filesStatus) {
          const summary = parsed.summary || {};
          filesStatus.textContent = `Imported ${books.length} book(s). Extracted ${summary.scenes || 0} scenes, ${summary.encounters || 0} encounters, and ${summary.items || 0} items.`;
        }
      } catch (error) {
        if (filesStatus) {
          filesStatus.textContent = `File import failed: ${String(error.message || error)}`;
        }
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
          urlStatus.textContent = `Imported ${books.length} book(s) from URL. Extracted ${summary.scenes || 0} scenes, ${summary.encounters || 0} encounters, ${summary.monsters || 0} monsters, and ${summary.spells || 0} spells.`;
        }
      } catch (error) {
        if (urlStatus) {
          urlStatus.textContent = `URL import failed: ${String(error.message || error)}`;
        }
      }
    });
  }

  // ---- Sourcebook PDF import: parse -> review/edit -> confirm-save ----
  const pdfFile = root.querySelector("#hb-pdf-file");
  const pdfText = root.querySelector("#hb-pdf-text");
  const pdfParse = root.querySelector("#hb-pdf-parse");
  const pdfStatus = root.querySelector("#hb-pdf-status");
  const pdfReview = root.querySelector("#hb-pdf-review");

  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  if (pdfParse && pdfReview) {
    // Flat index of the rendered candidates, so the import step can read the
    // (possibly edited) name + include checkbox for each one back out of the DOM.
    let flat = [];

    function renderReview(candidates) {
      flat = [];
      const groups = [
        ["races", "Races"],
        ["subclasses", "Subclasses"],
        ["backgrounds", "Backgrounds"],
        ["feats", "Feats"]
      ];
      let html = "";
      for (const [key, label] of groups) {
        const list = Array.isArray(candidates[key]) ? candidates[key] : [];
        if (!list.length) {
          continue;
        }
        html += `<div class="small" style="margin-top:10px;font-weight:600">${label}</div>`;
        for (const item of list) {
          const idx = flat.length;
          flat.push(item);
          const sub = item.className ? ` — ${esc(item.className)}` : item.size ? ` — ${esc(item.size)}` : "";
          html += `<label class="list-item" style="display:flex;gap:8px;align-items:center">
            <input type="checkbox" class="hb-pdf-pick" data-idx="${idx}" checked />
            <input type="text" class="hb-pdf-name" data-idx="${idx}" value="${esc(item.name)}" style="flex:1" />
            <span class="tag">${esc(item.kind)}${sub}</span>
          </label>`;
        }
      }
      if (!flat.length) {
        pdfReview.innerHTML = `<div class="small">No importable content found in this book.</div>`;
        return;
      }
      pdfReview.innerHTML = `${html}
        <button id="hb-pdf-import" type="button" style="margin-top:12px">Import selected as custom content</button>
        <div class="small" id="hb-pdf-import-status"></div>`;

      const importBtn = pdfReview.querySelector("#hb-pdf-import");
      const importStatus = pdfReview.querySelector("#hb-pdf-import-status");
      importBtn.addEventListener("click", async () => {
        const picks = Array.from(pdfReview.querySelectorAll(".hb-pdf-pick"));
        const items = picks
          .filter((box) => box.checked)
          .map((box) => {
            const idx = Number(box.getAttribute("data-idx"));
            const nameInput = pdfReview.querySelector(`.hb-pdf-name[data-idx="${idx}"]`);
            const name = String(nameInput?.value || "").trim();
            return name ? { ...flat[idx], name } : null;
          })
          .filter(Boolean);
        if (!items.length) {
          importStatus.textContent = "Select at least one entry to import.";
          return;
        }
        importBtn.disabled = true;
        importStatus.textContent = `Saving ${items.length} item(s)…`;
        try {
          await store.saveCustomContent(items);
          importStatus.textContent = `Imported ${items.length} item(s) as custom content.`;
        } catch (error) {
          importStatus.textContent = `Save failed: ${String(error.message || error)}. (Custom-content storage may not be available yet.)`;
        } finally {
          importBtn.disabled = false;
        }
      });
    }

    pdfParse.addEventListener("click", async () => {
      const file = (pdfFile && pdfFile.files && pdfFile.files[0]) || null;
      const text = String((pdfText && pdfText.value) || "").trim();
      if (!file && !text) {
        if (pdfStatus) pdfStatus.textContent = "Choose a PDF or paste some text first.";
        return;
      }
      pdfReview.innerHTML = "";
      if (pdfStatus) {
        pdfStatus.textContent = file
          ? "Extracting and parsing the PDF… this can take a while for a large book."
          : "Parsing the text…";
      }
      pdfParse.disabled = true;
      try {
        const res = await store.importSourcebookPdf(file ? { file } : { text });
        if (!res || res.ok !== true) {
          if (pdfStatus) {
            pdfStatus.textContent = (res && res.reason) || "Couldn't parse this book. Try pasting a section, or add content manually.";
          }
          return;
        }
        if (pdfStatus) {
          pdfStatus.textContent = `Found ${res.count} option(s) in ${esc(res.source || "the book")}. Review, edit, then import below.`;
        }
        renderReview(res.candidates || {});
      } catch (error) {
        if (pdfStatus) {
          pdfStatus.textContent = `Import failed: ${String(error.message || error)}`;
        }
      } finally {
        pdfParse.disabled = false;
      }
    });
  }
}
