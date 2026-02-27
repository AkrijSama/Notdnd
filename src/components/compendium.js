export function renderCompendium(state, query = "") {
  const q = query.trim().toLowerCase();

  const rows = state.books.flatMap((book) => {
    const chapterRows = (book.chapters || []).map((chapter) => ({
      id: `${book.id}:${chapter}`,
      title: chapter,
      type: "Chapter",
      parent: book.title,
      tags: book.tags || []
    }));

    return [
      {
        id: book.id,
        title: book.title,
        type: `${book.type} Book`,
        parent: "Library",
        tags: book.tags || []
      },
      ...chapterRows
    ];
  });

  const results = q
    ? rows.filter((row) => {
        const corpus = `${row.title} ${row.type} ${row.parent} ${(row.tags || []).join(" ")}`.toLowerCase();
        return corpus.includes(q);
      })
    : rows;

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>Compendium</h2>
        <span class="tag">Unified rules + homebrew index</span>
      </div>

      <form id="compendium-search" class="inline">
        <input name="query" value="${query}" placeholder="Search feats, monsters, spells, lore..." style="flex:1; min-width:220px;" />
        <button type="submit" class="ghost">Search</button>
      </form>

      <div class="small">${results.length} indexed entries</div>
      <ul class="list">
        ${results
          .slice(0, 60)
          .map(
            (result) => `
            <li class="list-item">
              <div class="inline">
                <strong>${result.title}</strong>
                <span class="tag">${result.type}</span>
              </div>
              <div class="small">Source: ${result.parent}</div>
              <div>${(result.tags || []).map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
            </li>
          `
          )
          .join("")}
      </ul>
    </section>
  `;
}

export function bindCompendium(root, onSearch) {
  const form = root.querySelector("#compendium-search");
  if (!form) {
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = new FormData(form);
    const query = String(payload.get("query") || "");
    onSearch(query);
  });
}
