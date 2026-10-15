// Modelo de la sección "Maratones": catálogo de sagas y actores + progreso
// gamificado por usuario.
//
// Reglas del juego:
//   - Cada maratón es una lista ORDENADA de obras (los `items`).
//   - Sólo se puede marcar como vista la primera obra pendiente: hasta que no
//     marcas la 1ª no se desbloquea la 2ª (progreso estrictamente secuencial).
//   - El progreso `watched` es siempre un prefijo de la lista, así que "la
//     primera pendiente" es la única marcable y la última vista la única que se
//     puede desmarcar.
//
// Firestore:
//   marathons           -> 1 doc por maratón (id = slug). Guarda los items dentro
//                          del propio doc: leer un maratón es 1 lectura.
//   marathon_progress   -> 1 doc por usuario+maratón (id = userId__marathonId)
//
// En modo local (pruebas/CI, DISABLE_FIREBASE=1) el catálogo sale del fichero
// curado y el progreso vive en memoria, igual que hacen movieModel/seriesModel.

const firebaseConn = require("./firebase");
const db = firebaseConn.getDb();
const { slugify } = require("./mediaKey");
const { MARATHON_CATALOG } = require("../data/marathonCatalog");

const MARATHONS_COLLECTION = "marathons";
const PROGRESS_COLLECTION = "marathon_progress";

const CACHE_TTL_MS = Math.min(
    Math.max(Number.parseInt(process.env.MARATHONS_CACHE_TTL_MS, 10) || 60 * 1000, 1000),
    30 * 60 * 1000
);

let cache = { items: null, builtAt: 0 };
const localProgress = new Map();

// Límite defensivo: un maratón no debería pasar de aquí (evita listas inmensas
// en Firestore y en el front).
const MAX_ITEMS = 60;

function httpError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function itemIdOf(item) {
    const imdb = String((item && item.imdbID) || "").trim().toLowerCase();
    if (/^tt\d{1,12}$/.test(imdb)) return imdb;
    const year = String((item && item.year) || "").trim().slice(0, 4);
    const base = slugify(String((item && item.title) || "sin-titulo"));
    return year ? `${base}-${year}` : base;
}

function mediaTypeOf(raw) {
    const value = String(raw || "").trim().toLowerCase();
    return value === "series" || value === "serie" || value === "tv" ? "series" : "movie";
}

function runtimeMinutesOf(item) {
    const match = String((item && item.runtime) || "").match(/(\d{1,4})/);
    return match ? Number.parseInt(match[1], 10) : 0;
}

function formatRuntime(minutes) {
    if (!minutes || minutes <= 0) return null;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function progressDocId(userId, marathonId) {
    return `${slugify(String(userId))}__${slugify(String(marathonId))}`;
}

// Normaliza un item tal y como se guarda y se sirve al front.
function toItem(raw, index, fallbackType) {
    const item = {
        itemId: itemIdOf(raw),
        order: Number(raw && raw.order) || index + 1,
        title: String((raw && raw.title) || "Sin título").slice(0, 200),
        year: raw && raw.year ? String(raw.year).slice(0, 4) : null,
        mediaType: mediaTypeOf((raw && raw.mediaType) || (raw && raw.type) || fallbackType),
        imdbID: raw && raw.imdbID ? String(raw.imdbID).toLowerCase() : null,
        poster: (raw && raw.poster) || null,
        genre: (raw && raw.genre) || null,
        rating: (raw && raw.rating) || null,
        runtime: (raw && raw.runtime) || null,
        plot: (raw && raw.plot) || null,
        director: (raw && raw.director) || null,
        actors: (raw && raw.actors) || null
    };
    item.runtimeMinutes = runtimeMinutesOf(item);
    return item;
}

// Normaliza un maratón completo (venga de Firestore o del catálogo curado).
function normalizeMarathon(raw) {
    const items = (Array.isArray(raw && raw.items) ? raw.items : [])
        .map((item, index) => toItem(item, index))
        .sort((a, b) => a.order - b.order)
        .slice(0, MAX_ITEMS)
        .map((item, index) => ({ ...item, order: index + 1 }));

    const totalMinutes = items.reduce((sum, item) => sum + item.runtimeMinutes, 0);
    const firstWithPoster = items.find((item) => item.poster);

    return {
        id: String((raw && raw.id) || slugify((raw && raw.title) || "maraton")),
        title: String((raw && raw.title) || "Maratón").slice(0, 120),
        kind: (raw && raw.kind) === "actor" ? "actor" : "saga",
        description: String((raw && raw.description) || "").slice(0, 500),
        order: Number(raw && raw.order) || 0,
        poster: (raw && raw.poster) || (firstWithPoster ? firstWithPoster.poster : null),
        items,
        itemCount: items.length,
        totalMinutes,
        runtimeLabel: formatRuntime(totalMinutes),
        updatedAt: (raw && raw.updatedAt) || null
    };
}

// Catálogo en modo local: el curado, sin enriquecer con OMDb.
function buildLocalCatalog() {
    return sortMarathons(
        MARATHON_CATALOG.map((definition) =>
            normalizeMarathon({
                ...definition,
                items: definition.items.map((item, index) => ({ ...item, order: index + 1 }))
            })
        )
    );
}

function sortMarathons(list) {
    return [...list].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.kind !== b.kind) return a.kind === "saga" ? -1 : 1;
        return a.title.localeCompare(b.title, "es");
    });
}

async function loadMarathons({ force } = {}) {
    const now = Date.now();
    if (!force && cache.items && now - cache.builtAt < CACHE_TTL_MS) return cache.items;

    let items;
    if (!db) {
        items = buildLocalCatalog();
    } else {
        const snapshot = await db.collection(MARATHONS_COLLECTION).get();
        items = sortMarathons(
            snapshot.docs.map((doc) => normalizeMarathon({ id: doc.id, ...doc.data() }))
        );
    }
    cache = { items, builtAt: now };
    return items;
}

function invalidateCache() {
    cache = { items: null, builtAt: 0 };
}

async function getMarathon(id) {
    const clean = String(id || "").trim();
    if (!clean) return null;
    const all = await loadMarathons();
    return all.find((m) => m.id === clean) || null;
}

// ---- Progreso ----

function emptyProgress(userId, marathonId) {
    return {
        userId,
        marathonId,
        watched: [],
        watchedAt: {},
        startedAt: null,
        completedAt: null,
        updatedAt: null
    };
}

function normalizeProgress(raw, userId, marathonId) {
    const watched = Array.isArray(raw && raw.watched)
        ? raw.watched.map((id) => String(id)).filter(Boolean)
        : [];
    return {
        userId: String((raw && raw.userId) || userId),
        marathonId: String((raw && raw.marathonId) || marathonId),
        watched,
        watchedAt: (raw && typeof raw.watchedAt === "object" && raw.watchedAt) || {},
        startedAt: (raw && raw.startedAt) || null,
        completedAt: (raw && raw.completedAt) || null,
        updatedAt: (raw && raw.updatedAt) || null
    };
}

async function readProgress(userId, marathonId) {
    const id = progressDocId(userId, marathonId);
    if (!db) {
        return localProgress.get(id) || emptyProgress(String(userId), String(marathonId));
    }
    const doc = await db.collection(PROGRESS_COLLECTION).doc(id).get();
    if (!doc.exists) return emptyProgress(String(userId), String(marathonId));
    return normalizeProgress(doc.data(), userId, marathonId);
}

async function writeProgress(progress) {
    const id = progressDocId(progress.userId, progress.marathonId);
    const payload = { ...progress, updatedAt: new Date().toISOString() };
    if (!db) {
        localProgress.set(id, payload);
        return payload;
    }
    await db.collection(PROGRESS_COLLECTION).doc(id).set(payload, { merge: true });
    return payload;
}

async function deleteProgress(userId, marathonId) {
    const id = progressDocId(userId, marathonId);
    if (!db) {
        localProgress.delete(id);
        return;
    }
    await db.collection(PROGRESS_COLLECTION).doc(id).delete();
}

async function listProgressForUser(userId) {
    const clean = String(userId || "");
    const byMarathon = new Map();
    if (!db) {
        for (const [, progress] of localProgress) {
            if (progress.userId === clean) byMarathon.set(progress.marathonId, progress);
        }
        return byMarathon;
    }
    const snapshot = await db.collection(PROGRESS_COLLECTION).where("userId", "==", clean).get();
    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (data.marathonId) byMarathon.set(String(data.marathonId), normalizeProgress(data, clean, data.marathonId));
    });
    return byMarathon;
}

// Resumen de progreso de un maratón (lo que consume el front).
function summarize(marathon, progress) {
    const ids = marathon.items.map((item) => item.itemId);
    const watched = progress ? ids.filter((id) => progress.watched.includes(id)) : [];
    const total = ids.length;
    const percent = total > 0 ? Math.round((watched.length / total) * 100) : 0;
    const nextItem = marathon.items[watched.length] || null;
    return {
        marathonId: marathon.id,
        watchedCount: watched.length,
        total,
        percent,
        completed: total > 0 && watched.length === total,
        nextItemId: nextItem ? nextItem.itemId : null,
        nextItemTitle: nextItem ? nextItem.title : null,
        watched,
        watchedAt: (progress && progress.watchedAt) || {},
        startedAt: (progress && progress.startedAt) || null,
        completedAt: (progress && progress.completedAt) || null
    };
}

// Maratón con el estado de cada obra para un usuario concreto.
async function getMarathonDetail(id, userId) {
    const marathon = await getMarathon(id);
    if (!marathon) return null;
    const progress = userId ? await readProgress(userId, marathon.id) : null;
    const watchedSet = new Set(progress ? progress.watched : []);
    const lastWatchedId = progress && progress.watched.length
        ? progress.watched[progress.watched.length - 1]
        : null;

    let allPreviousWatched = true;
    const items = marathon.items.map((item) => {
        const watched = watchedSet.has(item.itemId);
        const locked = !watched && !allPreviousWatched;
        const decorated = {
            ...item,
            watched,
            locked,
            unlockable: !watched && allPreviousWatched,
            canUnmark: watched && item.itemId === lastWatchedId
        };
        if (!watched) allPreviousWatched = false;
        return decorated;
    });

    return {
        marathon: { ...marathon, items },
        progress: summarize(marathon, progress)
    };
}

// Marca una obra como vista. Sólo se admite la primera pendiente.
async function markWatched(userId, marathonId, itemId) {
    const marathon = await getMarathon(marathonId);
    if (!marathon) throw httpError("MARATHON_NOT_FOUND", "Maratón no encontrado");
    const ids = marathon.items.map((item) => item.itemId);
    const index = ids.indexOf(String(itemId));
    if (index === -1) throw httpError("ITEM_NOT_FOUND", "Esa obra no forma parte del maratón");

    const progress = await readProgress(userId, marathonId);
    if (progress.watched.includes(ids[index])) {
        const detail = await getMarathonDetail(marathonId, userId);
        return { ...detail, alreadyWatched: true };
    }

    const pendingBefore = ids.slice(0, index).filter((id) => !progress.watched.includes(id));
    if (pendingBefore.length > 0) {
        const blockerIndex = ids.indexOf(pendingBefore[0]);
        const blocker = marathon.items[blockerIndex];
        throw httpError(
            "MARATHON_LOCKED",
            `Primero tienes que ver «${blocker.title}» (${blocker.year || "s/f"})`
        );
    }

    const now = new Date().toISOString();
    progress.watched = [...progress.watched, ids[index]];
    progress.watchedAt = { ...(progress.watchedAt || {}), [ids[index]]: now };
    if (!progress.startedAt) progress.startedAt = now;
    if (progress.watched.length === ids.length) progress.completedAt = now;
    await writeProgress(progress);

    await syncAchievements(userId);
    const detail = await getMarathonDetail(marathonId, userId);
    return { ...detail, justCompleted: !!progress.completedAt };
}

// Desmarca la última obra vista (mantiene el progreso como prefijo).
async function unmarkWatched(userId, marathonId, itemId) {
    const marathon = await getMarathon(marathonId);
    if (!marathon) throw httpError("MARATHON_NOT_FOUND", "Maratón no encontrado");
    const progress = await readProgress(userId, marathonId);
    const lastIndex = progress.watched.length - 1;
    if (lastIndex < 0 || progress.watched[lastIndex] !== String(itemId)) {
        throw httpError(
            "NOT_LAST_WATCHED",
            "Sólo puedes desmarcar la última obra que marcaste como vista"
        );
    }
    progress.watched = progress.watched.slice(0, lastIndex);
    const watchedAt = { ...(progress.watchedAt || {}) };
    delete watchedAt[String(itemId)];
    progress.watchedAt = watchedAt;
    progress.completedAt = null;
    if (progress.watched.length === 0) progress.startedAt = null;
    await writeProgress(progress);

    return await getMarathonDetail(marathonId, userId);
}

async function resetMarathon(userId, marathonId) {
    const marathon = await getMarathon(marathonId);
    if (!marathon) throw httpError("MARATHON_NOT_FOUND", "Maratón no encontrado");
    await deleteProgress(userId, marathonId);
    return await getMarathonDetail(marathonId, userId);
}

// ---- Logros ----
// Los logros son PERMANENTES: se guardan en `marathon_achievements` en cuanto se
// consiguen, así que reiniciar un maratón no te quita la insignia. Las barras de
// progreso, en cambio, se calculan al vuelo con el estado actual.
const ACHIEVEMENTS_COLLECTION = "marathon_achievements";
const localAchievements = new Map();

const ACHIEVEMENTS = [
    {
        id: "primer-paso",
        title: "Primer paso",
        description: "Marca tu primera obra como vista.",
        target: 1,
        current: (stats) => stats.totalWatched
    },
    {
        id: "doble-sesion",
        title: "Doble sesión",
        description: "Acumula 10 obras vistas en cualquier maratón.",
        target: 10,
        current: (stats) => stats.totalWatched
    },
    {
        id: "maratonista",
        title: "Maratonista",
        description: "Completa tu primer maratón entero.",
        target: 1,
        current: (stats) => stats.completedEver
    },
    {
        id: "triple-sesion",
        title: "Triple sesión",
        description: "Completa 3 maratones.",
        target: 3,
        current: (stats) => stats.completedEver
    },
    {
        id: "fan-de-actor",
        title: "Fan de actor",
        description: "Completa un maratón de un actor o actriz.",
        target: 1,
        current: (stats) => stats.completedActorEver
    },
    {
        id: "leyenda-del-cine",
        title: "Leyenda del cine",
        description: "Completa todos los maratones disponibles.",
        target: null,
        current: (stats) => stats.completedEver
    }
];

function emptyAchievementProfile(userId) {
    return { userId: String(userId), unlocked: {}, completed: {}, updatedAt: null };
}

async function readAchievementProfile(userId) {
    const clean = String(userId);
    if (!db) return localAchievements.get(clean) || emptyAchievementProfile(clean);
    const doc = await db.collection(ACHIEVEMENTS_COLLECTION).doc(slugify(clean)).get();
    if (!doc.exists) return emptyAchievementProfile(clean);
    const data = doc.data() || {};
    return {
        userId: clean,
        unlocked: (data.unlocked && typeof data.unlocked === "object") ? data.unlocked : {},
        completed: (data.completed && typeof data.completed === "object") ? data.completed : {},
        updatedAt: data.updatedAt || null
    };
}

async function writeAchievementProfile(profile) {
    const payload = { ...profile, updatedAt: new Date().toISOString() };
    if (!db) {
        localAchievements.set(String(profile.userId), payload);
        return payload;
    }
    await db.collection(ACHIEVEMENTS_COLLECTION).doc(slugify(String(profile.userId))).set(payload, { merge: true });
    return payload;
}

// Estadísticas del usuario: `completed` es el estado actual y `completedEver` el
// histórico (lo que alimenta los logros, que no se pierden al reiniciar).
function buildStats(marathons, progressByMarathon, profile) {
    let totalWatched = 0;
    let completed = 0;
    let started = 0;

    for (const marathon of marathons) {
        const summary = summarize(marathon, progressByMarathon.get(marathon.id) || null);
        totalWatched += summary.watchedCount;
        if (summary.watchedCount > 0) started += 1;
        if (summary.completed) completed += 1;
    }

    const completedEverIds = Object.keys((profile && profile.completed) || {});
    const completedActorEver = completedEverIds.filter((id) => {
        const marathon = marathons.find((m) => m.id === id);
        return !!marathon && marathon.kind === "actor";
    }).length;

    const totalItems = marathons.reduce((sum, marathon) => sum + marathon.itemCount, 0);
    return {
        totalWatched,
        totalItems,
        percent: totalItems > 0 ? Math.round((totalWatched / totalItems) * 100) : 0,
        marathonsTotal: marathons.length,
        started,
        completed,
        completedEver: completedEverIds.length,
        completedActorEver
    };
}

function evaluateAchievements(stats, marathonCount, profile) {
    const unlocked = (profile && profile.unlocked) || {};
    return ACHIEVEMENTS.map((achievement) => {
        const target = achievement.target === null ? marathonCount : achievement.target;
        const current = achievement.current(stats);
        return {
            id: achievement.id,
            title: achievement.title,
            description: achievement.description,
            current: Math.min(current, target),
            target,
            unlocked: !!unlocked[achievement.id] || (target > 0 && current >= target),
            unlockedAt: unlocked[achievement.id] || null
        };
    });
}

async function getAchievements(userId, progressByMarathonArg) {
    const marathons = await loadMarathons();
    const progressByMarathon = progressByMarathonArg
        || (userId ? await listProgressForUser(userId) : new Map());
    const profile = userId ? await readAchievementProfile(userId) : emptyAchievementProfile("");
    const stats = buildStats(marathons, progressByMarathon, profile);
    return { stats, achievements: evaluateAchievements(stats, marathons.length, profile) };
}

// ---- Perfil público (social) ----
// Lo que ve otra persona en el perfil de un usuario: sus estadísticas, sus
// logros y SÓLO los maratones que ha empezado o completado, con la última obra
// vista y la siguiente pendiente. Mismo criterio que las películas guardadas,
// que ya se muestran en el perfil público.

function publicItem(item) {
    if (!item) return null;
    return {
        itemId: item.itemId,
        order: item.order,
        title: item.title,
        year: item.year,
        mediaType: item.mediaType,
        poster: item.poster
    };
}

async function getUserSummary(userId) {
    const clean = String(userId || "").trim();
    const marathons = await loadMarathons();
    const progressByMarathon = clean ? await listProgressForUser(clean) : new Map();
    const profile = clean ? await readAchievementProfile(clean) : emptyAchievementProfile("");
    const stats = buildStats(marathons, progressByMarathon, profile);

    const entries = [];
    for (const marathon of marathons) {
        const summary = summarize(marathon, progressByMarathon.get(marathon.id) || null);
        if (summary.watchedCount === 0) continue;

        // Se localiza la última vista por su id (y no por posición) para que un
        // documento antiguo con un progreso no consecutivo no muestre la obra
        // equivocada; `watchedAt` da la fecha real de visionado.
        const lastWatchedId = summary.watched[summary.watched.length - 1];
        const lastWatched = marathon.items.find((item) => item.itemId === lastWatchedId) || null;
        const nextItem = marathon.items[summary.watchedCount] || null;

        entries.push({
            id: marathon.id,
            title: marathon.title,
            kind: marathon.kind,
            poster: marathon.poster,
            itemCount: marathon.itemCount,
            runtimeLabel: marathon.runtimeLabel,
            watchedCount: summary.watchedCount,
            total: summary.total,
            percent: summary.percent,
            completed: summary.completed,
            startedAt: summary.startedAt,
            completedAt: summary.completedAt,
            lastWatchedAt: (summary.watchedAt && lastWatchedId && summary.watchedAt[lastWatchedId]) || null,
            lastWatched: publicItem(lastWatched),
            nextItem: publicItem(nextItem)
        });
    }

    // Lo último que ha visto, primero: es lo que hace interesante un perfil.
    entries.sort((a, b) => String(b.lastWatchedAt || "").localeCompare(String(a.lastWatchedAt || "")));

    return {
        stats,
        achievements: evaluateAchievements(stats, marathons.length, profile),
        marathons: entries
    };
}

// Tras marcar una obra: apunta el maratón como superado y sella los logros que
// se acaben de conseguir para que sean definitivos.
async function syncAchievements(userId) {
    const marathons = await loadMarathons();
    const progressByMarathon = await listProgressForUser(userId);
    const profile = await readAchievementProfile(userId);

    for (const marathon of marathons) {
        const summary = summarize(marathon, progressByMarathon.get(marathon.id) || null);
        if (summary.completed && !profile.completed[marathon.id]) {
            profile.completed[marathon.id] = new Date().toISOString();
        }
    }

    const stats = buildStats(marathons, progressByMarathon, profile);
    const achievements = evaluateAchievements(stats, marathons.length, profile);
    const now = new Date().toISOString();
    for (const achievement of achievements) {
        if (achievement.unlocked && !profile.unlocked[achievement.id]) {
            profile.unlocked[achievement.id] = now;
        }
    }
    await writeAchievementProfile(profile);
    return { stats, achievements: evaluateAchievements(stats, marathons.length, profile) };
}

const MarathonModel = {
    isFirestoreConnected: () => firebaseConn.isFirestoreConnected(),
    loadMarathons,
    getMarathon,
    getMarathonDetail,
    invalidateCache,
    markWatched,
    unmarkWatched,
    resetMarathon,
    getAchievements,
    getUserSummary,
    summarize,
    listProgressForUser,
    readProgress,
    itemIdOf
};

module.exports = { MarathonModel, MARATHONS_COLLECTION, PROGRESS_COLLECTION };
