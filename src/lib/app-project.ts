/*
 * An app built by Flash as a project folder, to keep working on it in Cursor, VS Code or any
 * editor: the app's page, a stand-in for Flash's database so it runs anywhere, a README and a
 * package.json that starts a local server with Vite.
 */
import { MEMORY_DB, injectHead } from "./flashdb-shim.ts";
import { zip } from "./zip.ts";

/** A file-name friendly version of an app's title. */
export function appSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "flash-app"
  );
}

const STAND_IN_MARK = "Stand-in for Flash's built-in database";

// Runs only where Flash's real database isn't there, so the same page still saves for real on Flash.
const STAND_IN = `
<script>
  /* ${STAND_IN_MARK} (window.flashDB), so this app runs anywhere.
     It keeps data in memory, so it starts empty each time the page loads.
     On Flash, the real database is used instead and this does nothing.
     To use your own backend, replace these functions with calls to it. */
  if (!window.flashDB) (function () {${MEMORY_DB}
  })();
</script>`;

/** The app's page with the database stand-in at the top (once, even if it was downloaded before). */
export function standalonePage(html: string): string {
  return html.includes(STAND_IN_MARK) ? html : injectHead(html, STAND_IN);
}

function readme(title: string, slug: string, link: string): string {
  return `# ${title}

Made with Flash: https://www.flash-app.dev${link ? `\n\nLive at ${link}` : ""}

## Open it

- **Quick look:** double-click \`index.html\` to open it in your browser.
- **In Cursor or VS Code:** choose File > Open Folder and pick the \`${slug}\` folder. In the terminal, run:

  \`\`\`
  npm install
  npm run dev
  \`\`\`

  Then open the link it prints (usually http://localhost:5173). The page reloads each time you save.

## What's inside

- \`index.html\`: the whole app, with its layout, styles and code.
- The first script in \`index.html\` is a stand-in for Flash's database (\`window.flashDB\`). Here it keeps data in memory, so
  it starts empty each time the page loads. When the app runs on Flash, Flash's real database is used instead.
  To use your own backend, replace its functions with calls to your server.
- \`package.json\`: starts a local server with Vite.

## Put it online

\`npm run build\` makes a ready-to-host copy in the \`dist\` folder, for any static host.

## Keep building with Flash

Attach \`index.html\` to a Flash chat and say what to change. Publish it from Flash to keep its database,
forms and payments working.
`;
}

/** The files of an app's project folder, inside a folder named after the app. */
export function projectFiles(app: { title: string; html: string }, link = ""): { name: string; data: string }[] {
  const slug = appSlug(app.title);
  const pkg = {
    name: slug,
    private: true,
    version: "1.0.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    devDependencies: { vite: "^8.3.4" },
  };
  return [
    { name: `${slug}/index.html`, data: standalonePage(app.html) },
    { name: `${slug}/README.md`, data: readme(app.title, slug, link) },
    { name: `${slug}/package.json`, data: `${JSON.stringify(pkg, null, 2)}\n` },
    { name: `${slug}/.gitignore`, data: "node_modules\ndist\n" },
  ];
}

/** The app's project folder as a .zip file. */
export function projectZip(app: { title: string; html: string }, link = ""): Uint8Array {
  return zip(projectFiles(app, link));
}
