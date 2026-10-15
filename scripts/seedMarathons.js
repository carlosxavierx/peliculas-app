/**
 * Carga las maratones (sagas y actores) en Firebase.
 *
 * Para cada obra del catálogo curado (src-backend/data/marathonCatalog.js):
 *   1. Resuelve sus datos reales en OMDb (por imdbID y, si no cuadra, por
 *      búsqueda de título+año, para que un id mal puesto no meta otra película).
 *   2. Se asegura de que esa obra existe en el catálogo de la app
 *      (colecciones `movies` / `series`) — así toda la información vive en la
 *      base de datos y la web la puede mostrar como cualquier otra ficha.
 *   3. Escribe el documento del maratón en la colección `marathons`, con sus
 *      obras ORDENADAS (el orden es el del desbloqueo secuencial).
 *
 * Uso:
 *   node scripts/seedMarathons.js                      # carga/actualiza todo
 *   node scripts/seedMarathons.js --dry-run            # solo comprueba OMDb, sin escribir
 *   node scripts/seedMarathons.js --only=saga-matrix   # un solo maratón
 *   node scripts/seedMarathons.js --sync-plots         # re-copia las sinopsis ya
 *                                                      # traducidas del catálogo
 *   node scripts/seedMarathons.js --cleanup            # borra las maratones creadas
 *
 * Es idempotente: reejecutarlo no duplica obras ni maratones. No borra nada del
 * catálogo (los títulos que añade son contenido legítimo de la app).
 *
 * Requiere OMDB_API_KEY y credenciales Firebase Admin en .env.
 * ~75 obras = ~80 peticiones a OMDb (el plan gratuito permite 1000/día).
 */

// Cargamos el .env ANTES de requerir los servicios: omdbService lee
// process.env.OMDB_API_KEY al importarse.
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const idx = trimmed.indexOf("=");
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnvFile();

const firebaseConn = require("../src-backend/models/firebase");
const { omdbService } = require("../src-backend/services/omdbService");
const { MovieModel } = require("../src-backend/models/movieModel");
const { SeriesModel } = require("../src-backend/models/seriesModel");
const { MARATHON_CATALOG } = require("../src-backend/data/marathonCatalog");

const db = firebaseConn.getDb();
const SEED_SOURCE = "marathon-catalog";
// Dueño de las fichas nuevas que añadimos al catálogo (mismo criterio que
// seedRandomMovies.js, que usa "catalog-seed").
const CATALOG_OWNER = "marathon-seed";
const PLACEHOLDER_PLOT = "Sin sinopsis disponible.";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const cleanup = args.includes("--cleanup");
const syncPlots = args.includes("--sync-plots");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=").slice(1).join("=").trim() : null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// Comparación deliberadamente estricta: más vale marcar una obra como no
// resuelta que colar la película equivocada en un maratón. Sólo aceptamos el
// mismo título o diferencias cortas de subtítulo ("Part II", "...: Wakanda
// Forever"). Un documental titulado "... and Other Tales of Twelve Monkeys"
// ya no pasa.
const MAX_TITLE_DIFF = 25;

function titlesMatch(a, b) {
    const left = normalizeText(a);
    const right = normalizeText(b);
    if (!left || !right) return false;
    if (left === right) return true;
    const [short, long] = left.length <= right.length ? [left, right] : [right, left];
    if (long.length - short.length > MAX_TITLE_DIFF) return false;
    return long.startsWith(short) || (short.length >= 6 && long.includes(short));
}

function yearsMatch(a, b) {
    const left = Number.parseInt(String(a || "").slice(0, 4), 10);
    const right = Number.parseInt(String(b || "").slice(0, 4), 10);
    if (Number.isNaN(left) || Number.isNaN(right)) return true;
    return Math.abs(left - right) <= 1;
}

function mediaTypeOf(raw) {
    return String((raw && raw.Type) || "").toLowerCase() === "series" ? "series" : "movie";
}

// Variantes de búsqueda cuando el imdbID falla: OMDb se atraganta con la
// puntuación de títulos largos ("Harry Potter and the ...").
function titleVariants(title) {
    const clean = String(title || "").trim();
    const out = [clean];
    const cut = clean.split(/[:!?]/)[0].trim();
    if (cut && cut !== clean) out.push(cut);
    const beforeDash = clean.split(" - ")[0].trim();
    if (beforeDash && beforeDash !== clean && !out.includes(beforeDash)) out.push(beforeDash);
    return out.filter(Boolean);
}

// Elige el mejor candidato de una búsqueda de OMDb. Devuelve null si ninguno
// es fiable, para no inventarse una película.
function pickBestResult(results, title, year) {
    const wanted = normalizeText(title);
    if (!wanted) return null;
    let best = null;
    for (const candidate of results) {
        if (!candidate || !candidate.imdbID) continue;
        const got = normalizeText(candidate.Title);
        if (!got) continue;
        const exact = got === wanted;
        if (!exact && !titlesMatch(candidate.Title, title)) continue;
        // Si no es el título exacto, exigimos además que el año cuadre.
        if (!exact && !yearsMatch(candidate.Year, year)) continue;
        const score = (exact ? 100 : 60)
            + (yearsMatch(candidate.Year, year) ? 40 : 0)
            - Math.abs(got.length - wanted.length);
        if (!best || score > best.score) best = { candidate, score };
    }
    return best ? best.candidate : null;
}

async function searchByTitle(title, year) {
    for (const variant of titleVariants(title)) {
        for (const withYear of [year, null]) {
            try {
                const data = await omdbService.searchMovies(variant, 1, withYear ? { year: withYear } : {});
                const results = Array.isArray(data.Search) ? data.Search : [];
                const found = pickBestResult(results, title, year);
                if (found) return found;
            } catch (error) {
                // "Movie not found!" es esperable al probar variantes: seguimos.
                if (!/not found|sin resultados/i.test(error.message || "")) {
                    console.warn(`    búsqueda "${variant}" falló: ${error.message}`);
                }
            }
            await delay(150);
        }
    }
    return null;
}

// Devuelve el JSON crudo de OMDb para una entrada curada.
async function resolveItem(item) {
    if (item.imdbID) {
        try {
            const raw = await omdbService.getById(item.imdbID);
            if (titlesMatch(raw.Title, item.title) && yearsMatch(raw.Year, item.year)) {
                return { raw, via: "id" };
            }
            console.warn(
                `    ! ${item.imdbID} no cuadra con "${item.title}" (${item.year}): OMDb dice "${raw.Title}" (${raw.Year}). Busco por título.`
            );
        } catch (error) {
            console.warn(`    ! getById(${item.imdbID}) falló: ${error.message}. Busco por título.`);
        }
    }
    const found = await searchByTitle(item.title, item.year);
    if (!found) return null;
    const raw = await omdbService.getById(found.imdbID);
    // El buscador de OMDb devuelve títulos recortados: nos quedamos con la ficha
    // completa, pero verificando que sigue siendo la misma obra.
    if (!yearsMatch(raw.Year, item.year) || !titlesMatch(raw.Title, item.title)) {
        console.warn(`    ! la búsqueda devolvió "${raw.Title}" (${raw.Year}), que no cuadra con "${item.title}" (${item.year}).`);
        return null;
    }
    return { raw, via: "search" };
}

// Ficha ya guardada en el catálogo (por imdbID), si existe.
async function findCatalogDoc(imdbID) {
    const id = String(imdbID || "").trim();
    if (!id) return null;
    for (const collection of ["movies", "series"]) {
        try {
            const snap = await db.collection(collection).where("imdbID", "==", id).limit(1).get();
            if (!snap.empty) return { collection, doc: { id: snap.docs[0].id, ...snap.docs[0].data() } };
        } catch (error) {
            console.warn(`  No se pudo consultar ${collection} por ${id}: ${error.message}`);
        }
    }
    return null;
}

// Asegura que la obra está en el catálogo y devuelve el item que irá dentro del
// maratón (con la sinopsis ya traducida si el catálogo la tenía).
async function ensureCatalogEntry(raw, existing, item) {
    const mediaType = mediaTypeOf(raw);
    const formatted = mediaType === "series" ? SeriesModel.formatData(raw) : MovieModel.formatData(raw);

    let dbDoc = existing;
    let created = false;
    if (!dbDoc && !dryRun) {
        const save = mediaType === "series"
            ? (data, owner) => SeriesModel.saveToDatabase(data, owner)
            : (data, owner) => MovieModel.saveToDatabase(data, owner);
        try {
            await save(formatted, CATALOG_OWNER);
            created = true;
            dbDoc = await findCatalogDoc(formatted.imdbID);
        } catch (error) {
            console.warn(`    ! No se pudo añadir "${formatted.title}" al catálogo: ${error.message}`);
        }
    }

    // La sinopsis del catálogo puede estar ya traducida al castellano
    // (scripts/translatePlots.js): preferimos esa a la inglesa de OMDb.
    const catalogPlot = dbDoc && dbDoc.plot && dbDoc.plot !== PLACEHOLDER_PLOT ? dbDoc.plot : null;

    return {
        created,
        item: {
            order: item.order,
            itemId: String(formatted.imdbID || "").toLowerCase() || null,
            title: formatted.title,
            year: String(formatted.year || "").slice(0, 4) || null,
            mediaType,
            imdbID: formatted.imdbID ? String(formatted.imdbID).toLowerCase() : null,
            poster: formatted.poster || (dbDoc && dbDoc.poster) || null,
            genre: formatted.genre || (dbDoc && dbDoc.genre) || null,
            rating: formatted.rating || (dbDoc && dbDoc.rating) || null,
            runtime: formatted.runtime || (dbDoc && dbDoc.runtime) || null,
            plot: catalogPlot || formatted.plot || null,
            director: formatted.director || (dbDoc && dbDoc.director) || null,
            actors: formatted.actors || (dbDoc && dbDoc.actors) || null
        }
    };
}

function runtimeMinutesOf(runtime) {
    const match = String(runtime || "").match(/(\d{1,4})/);
    return match ? Number.parseInt(match[1], 10) : 0;
}

function formatRuntime(minutes) {
    if (!minutes) return null;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min`;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

async function seedMarathon(definition) {
    console.log(`\n▶ ${definition.title} (${definition.kind}, ${definition.items.length} obras)`);
    const items = [];
    const failures = [];

    for (let index = 0; index < definition.items.length; index++) {
        const entry = definition.items[index];
        const position = index + 1;
        try {
            const resolved = await resolveItem(entry);
            if (!resolved) {
                failures.push(`${entry.title} (${entry.year})`);
                console.warn(`  ${position}/${definition.items.length} ✗ no encontrada en OMDb: ${entry.title}`);
                await delay(200);
                continue;
            }
            const existing = await findCatalogDoc(resolved.raw.imdbID);
            const { item, created } = await ensureCatalogEntry(resolved.raw, existing, {
                ...entry,
                order: position
            });
            items.push(item);
            const marks = [
                resolved.via === "search" ? "por búsqueda" : "por id",
                created ? "añadida al catálogo" : "ya en el catálogo",
                mediaTypeOf(resolved.raw) === "series" ? "serie" : "película"
            ];
            console.log(`  ${position}/${definition.items.length} ✓ ${item.title} (${item.year}) [${marks.join(", ")}]`);
        } catch (error) {
            failures.push(`${entry.title} (${entry.year})`);
            console.warn(`  ${position}/${definition.items.length} ✗ ${entry.title}: ${error.message}`);
        }
        await delay(200);
    }

    if (items.length === 0) {
        console.error(`  Sin obras resueltas: no se escribe "${definition.id}".`);
        return { failures, written: false, total: definition.items.length };
    }

    const totalMinutes = items.reduce((sum, item) => sum + runtimeMinutesOf(item.runtime), 0);
    const firstWithPoster = items.find((item) => item.poster);

    const doc = {
        id: definition.id,
        title: definition.title,
        kind: definition.kind,
        order: definition.order,
        description: definition.description,
        poster: firstWithPoster ? firstWithPoster.poster : null,
        items,
        itemCount: items.length,
        totalMinutes,
        runtimeLabel: formatRuntime(totalMinutes),
        seedSource: SEED_SOURCE,
        updatedAt: new Date().toISOString()
    };

    if (dryRun) {
        console.log(`  (dry-run) se escribiría ${definition.id} con ${items.length} obras.`);
        return { failures, written: false, total: items.length };
    }

    await db.collection("marathons").doc(definition.id).set(doc);
    console.log(`  → Guardado "${definition.id}": ${items.length} obras, ${doc.runtimeLabel || "duración desconocida"}.`);
    return { failures, written: true, total: definition.items.length };
}

// Re-copia las sinopsis del catálogo (ya traducidas) a los documentos de maratón.
async function runSyncPlots() {
    console.log("Re-sincronizando sinopsis desde el catálogo…");
    const snapshot = await db.collection("marathons").get();
    if (snapshot.empty) {
        console.log("No hay maratones que actualizar.");
        return;
    }
    const plots = new Map();
    for (const collection of ["movies", "series"]) {
        const docs = await db.collection(collection).limit(20000).get();
        docs.forEach((doc) => {
            const data = doc.data() || {};
            if (data.imdbID && data.plot && data.plot !== PLACEHOLDER_PLOT) {
                plots.set(String(data.imdbID).toLowerCase(), data.plot);
            }
        });
    }
    let updated = 0;
    for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        const items = (data.items || []).map((item) => {
            const translated = plots.get(String(item.imdbID || "").toLowerCase());
            if (translated && translated !== item.plot) {
                updated++;
                return { ...item, plot: translated };
            }
            return item;
        });
        await doc.ref.set({ items, updatedAt: new Date().toISOString() }, { merge: true });
    }
    console.log(`Sinopsis actualizadas: ${updated}.`);
}

async function runCleanup() {
    const snapshot = await db.collection("marathons").get();
    let removed = 0;
    for (const doc of snapshot.docs) {
        if ((doc.data() || {}).seedSource === SEED_SOURCE) {
            await doc.ref.delete();
            removed++;
        }
    }
    console.log(`Maratones eliminadas: ${removed}. (El catálogo movies/series no se toca.)`);
}

async function main() {
    if (!db) {
        console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
        process.exit(1);
    }
    if (!process.env.OMDB_API_KEY && !syncPlots && !cleanup) {
        console.error("Falta OMDB_API_KEY en .env.");
        process.exit(1);
    }

    if (cleanup) return runCleanup();
    if (syncPlots) return runSyncPlots();

    const selected = only
        ? MARATHON_CATALOG.filter((definition) => definition.id === only)
        : MARATHON_CATALOG;

    if (selected.length === 0) {
        console.error(`No hay ningún maratón con id "${only}".`);
        process.exitCode = 1;
        return;
    }

    console.log(`Maratones a cargar: ${selected.length}${dryRun ? " (dry-run)" : ""}`);
    const startedAt = Date.now();
    const failures = [];
    let written = 0;
    let items = 0;

    for (const definition of selected) {
        const result = await seedMarathon(definition);
        failures.push(...result.failures.map((title) => `${definition.id}: ${title}`));
        items += result.total;
        if (result.written) written++;
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\nHecho en ${seconds}s. Maratones escritas: ${written}. Obras procesadas: ${items}.`);
    if (failures.length) {
        console.warn(`Obras que no se pudieron resolver (${failures.length}):`);
        failures.forEach((title) => console.warn(`  - ${title}`));
    } else {
        console.log("Todas las obras del catálogo curado se resolvieron correctamente.");
    }
}

main().catch((error) => {
    console.error("Error durante la carga:", error.message || error);
    process.exitCode = 1;
});
