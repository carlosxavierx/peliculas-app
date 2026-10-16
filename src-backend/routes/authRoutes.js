const express = require("express");
const router = express.Router();
const { authService, findUserByNickname, setUserNickname, isAdmin, cardUser } = require("../services/authService");
const { FriendshipModel } = require("../models/friendshipModel");
const { MarathonModel } = require("../models/marathonModel");
const { MovieModel } = require("../models/movieModel");
const firebaseConn = require("../models/firebase");
const ActivityModel = require("../models/activityModel");
const db = firebaseConn.getDb();

function tokenFromHeader(req) {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

// POST /api/auth/firebase { idToken, name? } — verifica Firebase Auth y crea sesión propia
router.post("/auth/firebase", async (req, res) => {
    try {
        const body = req.body || {};
        if (typeof body !== "object" || !body.idToken) {
            return res.status(400).json({ error: "ID token de Firebase requerido" });
        }
        const { token, user } = await authService.loginWithFirebase({
            idToken: body.idToken,
            name: body.name
        });
        res.json({ ok: true, token, user });
    } catch (error) {
        if (error && (error.code === 8 || error.code === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED|quota exceeded/i.test(error.message || ""))) {
            console.error("[auth] Cuota de Firebase agotada:", error.message || error);
            return res.status(503).json({ error: "Firebase ha alcanzado su cuota temporal. Espera a que se restablezca e inténtalo de nuevo." });
        }
        if (error.code === "INVALID_FIREBASE_TOKEN") {
            return res.status(401).json({ error: error.message });
        }
        if (error.code === "FIREBASE_NOT_CONFIGURED") {
            return res.status(500).json({ error: error.message });
        }
        res.status(400).json({ error: error.message || "No se pudo entrar con Firebase" });
    }
});

// POST /api/auth/logout (Bearer opcional, siempre ok)
router.post("/auth/logout", async (req, res) => {
    try {
        await authService.logout(tokenFromHeader(req));
    } catch (e) {
        /* best-effort */
    }
    res.json({ ok: true });
});

// GET /api/auth/me (requiere Bearer válido)
router.get("/auth/me", async (req, res) => {
    try {
        const user = await authService.me(tokenFromHeader(req));
        if (!user) {
            return res.status(401).json({ error: "Sesión no válida" });
        }
        res.json({ user });
    } catch (error) {
        res.status(500).json({ error: "No se pudo comprobar la sesión" });
    }
});

// PUT /api/auth/prefs { favoriteGenres, likesMovies, onboardingDone }
// OJO: este router se monta en "/api" (server.js), por eso aquí va "/auth/..."
router.put("/auth/prefs", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        const body = req.body || {};
        if (typeof body !== "object") {
            return res.status(400).json({ error: "Cuerpo de petición inválido" });
        }
        const prefs = await authService.updatePrefs(token, {
            favoriteGenres: Array.isArray(body.favoriteGenres) ? body.favoriteGenres.slice(0, 3) : [],
            likesMovies: typeof body.likesMovies === "boolean" ? body.likesMovies : null,
            onboardingDone: body.onboardingDone === true
        });
        if (!prefs) {
            return res.status(401).json({ error: "Sesión no válida" });
        }
        res.json({ ok: true, prefs });
    } catch (error) {
        res.status(400).json({ error: error.message || "No se pudo actualizar" });
    }
});

// PUT /api/auth/profile { nickname, colorTheme }
router.put("/auth/profile", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        const body = req.body || {};
        if (typeof body !== "object") {
            return res.status(400).json({ error: "Cuerpo de petición inválido" });
        }
        const prefs = await authService.updateProfile(token, {
            nickname: body.nickname,
            colorTheme: body.colorTheme
        });
        if (!prefs) {
            return res.status(401).json({ error: "Sesión no válida" });
        }
        res.json({ ok: true, prefs });
    } catch (error) {
        res.status(400).json({ error: error.message || "No se pudo actualizar el perfil" });
    }
});

// GET /api/users/search?q=texto — Buscar usuarios
// IMPORTANTE: va ANTES de "/users/:id". Express resuelve en orden de registro
// y "/users/:id" también encaja con "/users/search", así que declararlo después
// dejaba la búsqueda tapada (respondía con el perfil de "search").
router.get("/users/search", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        let currentUserId = null;
        if (token) {
            const me = await authService.me(token);
            if (me) currentUserId = me.id;
        }
        const q = req.query.q || "";
        const users = await authService.searchUsers(q, { excludeId: currentUserId });
        res.json({ users });
    } catch (error) {
        res.status(500).json({ error: "No se pudo buscar usuarios" });
    }
});

// GET /api/users/:id — Perfil público de un usuario
router.get("/users/:id", async (req, res) => {
    try {
        const user = await authService.getPublicProfile(req.params.id);
        if (!user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }
        res.json({ user });
    } catch (error) {
        res.status(500).json({ error: "No se pudo obtener el perfil" });
    }
});

// GET /api/users/:id/movies — Películas guardadas de un usuario (público)
// Se lee del catálogo igual que en las rutas de amistades: la colección del
// usuario se identifica por su id (su email), nunca por algo que mande el cliente.
router.get("/users/:id/movies", async (req, res) => {
    try {
        const movies = await MovieModel.getAllMovies(String(req.params.id || "").trim().toLowerCase());
        res.json({ movies: Array.isArray(movies) ? movies : [] });
    } catch (error) {
        res.status(500).json({ error: "No se pudo obtener las películas" });
    }
});

// GET /api/users/:id/marathons — Maratones empezadas/completadas de un usuario
// (público, igual que sus películas guardadas). Alimenta el bloque "Maratones"
// del perfil, para que sus amigos vean por dónde va.
router.get("/users/:id/marathons", async (req, res) => {
    try {
        const summary = await MarathonModel.getUserSummary(req.params.id);
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: "No se pudieron obtener los maratones" });
    }
});

// GET /api/users/:id/series — Series guardadas de un usuario (público)
router.get("/users/:id/series", async (req, res) => {
    try {
        const series = await authService.getUserSeries(req.params.id);
        res.json({ series: Array.isArray(series) ? series : [] });
    } catch (error) {
        res.status(500).json({ error: "No se pudo obtener las series" });
    }
});

// NOTA: la ruta /users/search ya existe más arriba (línea ~115, con excludeId);
// no se duplica aquí.

// POST /api/users/:id/follow — Seguir a un usuario
router.post("/users/:id/follow", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        if (!token) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const result = await authService.followUser(token, req.params.id);
        if (!result) return res.status(401).json({ error: "Sesión no válida" });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message || "No se pudo seguir al usuario" });
    }
});

// DELETE /api/users/:id/follow — Dejar de seguir a un usuario
router.delete("/users/:id/follow", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        if (!token) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const result = await authService.unfollowUser(token, req.params.id);
        if (!result) return res.status(401).json({ error: "Sesión no válida" });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message || "No se pudo dejar de seguir" });
    }
});

// GET /api/users/me/following — Usuarios que sigo
router.get("/users/me/following", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        if (!token) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const following = await authService.getFollowing(token);
        if (following === null) return res.status(401).json({ error: "Sesión no válida" });
        res.json({ users: following });
    } catch (error) {
        res.status(500).json({ error: "No se pudo obtener seguidos" });
    }
});

// GET /api/users/me/followers — Mis seguidores
router.get("/users/me/followers", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        if (!token) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const followers = await authService.getFollowers(token);
        if (followers === null) return res.status(401).json({ error: "Sesión no válida" });
        res.json({ users: followers });
    } catch (error) {
        res.status(500).json({ error: "No se pudo obtener seguidores" });
    }
});

// GET /api/users/:id/is-following — Comprobar si sigo a un usuario
router.get("/users/:id/is-following", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        if (!token) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const following = await authService.isFollowing(token, req.params.id);
        res.json({ following });
    } catch (error) {
        res.status(500).json({ error: "No se pudo comprobar" });
    }
});

// POST /api/auth/nickname { nickname } — establece/actualiza el nickname único
router.post("/auth/nickname", async (req, res) => {
    try {
        const token = tokenFromHeader(req);
        // `readSession` se exporta suelto, no dentro de authService: antes esta
        // línea comparaba `await authService.readSession` (undefined) y la ruta
        // devolvía siempre 401, así que el apodo nunca llegaba a guardarse.
        const me = await authService.me(token);
        if (!me) return res.status(401).json({ error: "Sesión no válida" });
        const body = req.body || {};
        const nickname = (body.nickname || "").trim();
        if (!nickname) return res.status(400).json({ error: "Apodo requerido" });
        const saved = await setUserNickname(me.id, nickname);
        res.json({ ok: true, nickname: saved });
    } catch (error) {
        if (error.code === "NICKNAME_TAKEN") return res.status(409).json({ error: error.message });
        if (error.code === "INVALID_NICKNAME") return res.status(400).json({ error: error.message });
        res.status(400).json({ error: error.message || "No se pudo establecer el apodo" });
    }
});

// GET /api/auth/nickname/check/:nickname — verifica si un nickname está disponible
router.get("/auth/nickname/check/:nickname", async (req, res) => {
    try {
        const nickname = (req.params.nickname || "").trim().toLowerCase();
        if (!nickname) return res.status(400).json({ error: "Apodo requerido" });
        const existing = await findUserByNickname(nickname);
        res.json({ available: !existing });
    } catch (error) {
        res.status(400).json({ error: error.message || "Error al comprobar" });
    }
});

// ===== AMISTADES (delegado a FriendshipModel — modo local + Firestore) =====

async function authUserFromReq(req) {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try {
        return await authService.me(match[1].trim());
    } catch (e) {
        return null;
    }
}

function statusFor(error) {
    if (error && error.code === "BAD_REQUEST") return 400;
    if (error && error.code === "FORBIDDEN") return 403;
    if (error && error.code === "NOT_FOUND") return 404;
    if (error && error.code === "CONFLICT") return 409;
    const msg = (error && error.message) || "";
    if (/ya sois amigos|ya has enviado|ya te ha enviado|ya estaba aceptada|duplicad/i.test(msg)) return 409;
    if (/solo el|puede cancelarla|sin permiso|no autorizado/i.test(msg)) return 403;
    if (/no encontrad|no existe|no sois amigos/i.test(msg)) return 404;
    if (/inválido|falta|mismo|máximo|caracteres|demasiado largo|necesita/i.test(msg)) return 400;
    return 500;
}

function sendError(res, error) {
    res.status(statusFor(error)).json({ error: (error && error.message) || "Error interno del servidor" });
}

async function cardOrNull(userId) {
    try {
        const user = await authService.getById(userId);
        return user ? cardUser(user) : null;
    } catch (e) {
        return null;
    }
}

// GET /api/auth/friends — lista de amigos aceptados
router.get("/auth/friends", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const friendships = await FriendshipModel.getFriends(user.id);
        const friends = [];
        for (const f of friendships) {
            const card = await cardOrNull(f.friendId);
            if (card) friends.push({ ...card, since: f.since });
        }
        res.json({ friends });
    } catch (error) {
        sendError(res, error);
    }
});

// GET /api/auth/friends/requests — solicitudes pendientes recibidas
router.get("/auth/friends/requests", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const requests = await FriendshipModel.getReceivedRequests(user.id);
        const enriched = [];
        for (const r of requests) {
            enriched.push({ request: r, fromUser: await cardOrNull(r.from) });
        }
        res.json({ requests: enriched });
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/auth/friends/request { toNickname } — envía solicitud por nickname
router.post("/auth/friends/request", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const body = req.body || {};
        const toNickname = (body.toNickname || "").trim().toLowerCase();
        if (!toNickname) return res.status(400).json({ error: "Apodo del destino requerido" });
        if (!db) return res.status(503).json({ error: "Función no disponible en modo local" });
        const target = await findUserByNickname(toNickname);
        if (!target) return res.status(404).json({ error: "Usuario no encontrado" });
        if (target.id === user.id) return res.status(400).json({ error: "No te puedes agregar a ti mismo" });
        const request = await FriendshipModel.sendRequest({ from: user.id, to: target.id });
        res.status(201).json({ ok: true, request });
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/auth/friends/request/accept { requestId } — acepta solicitud
router.post("/auth/friends/request/accept", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const body = req.body || {};
        const requestId = body.requestId;
        if (!requestId) return res.status(400).json({ error: "ID de solicitud requerido" });
        const request = await FriendshipModel.acceptRequest(requestId, user.id);
        res.json({ ok: true, request });
    } catch (error) {
        sendError(res, error);
    }
});

// POST /api/auth/friends/request/decline { requestId } — rechaza solicitud
router.post("/auth/friends/request/decline", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const body = req.body || {};
        const requestId = body.requestId;
        if (!requestId) return res.status(400).json({ error: "ID de solicitud requerido" });
        const result = await FriendshipModel.rejectRequest(requestId, user.id);
        res.json(result);
    } catch (error) {
        sendError(res, error);
    }
});

// DELETE /api/auth/friends/:friendId — elimina amigo
router.delete("/auth/friends/:friendId", async (req, res) => {
    try {
        const user = await authUserFromReq(req);
        if (!user) return res.status(401).json({ error: "Requiere iniciar sesión" });
        const result = await FriendshipModel.removeFriend(user.id, req.params.friendId);
        res.json(result);
    } catch (error) {
        sendError(res, error);
    }
});

// GET /api/auth/user/:nickname — buscar usuario por nickname (para agregar amigo)
router.get("/auth/user/:nickname", async (req, res) => {
    try {
        const nickname = (req.params.nickname || "").trim().toLowerCase();
        if (!nickname) return res.status(400).json({ error: "Apodo requerido" });
        const user = await findUserByNickname(nickname);
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
        // El nickname puede estar en user.nickname o user.prefs.nickname
        const effectiveNickname = user.nickname || (user.prefs && user.prefs.nickname) || null;
        res.json({ user: { id: user.id, name: user.name, nickname: effectiveNickname, photoURL: user.photoURL } });
    } catch (error) {
        res.status(400).json({ error: error.message || "Error al buscar usuario" });
    }
});

// Middleware para verificar que el usuario es admin
async function requireAdmin(req, res, next) {
    try {
        const token = tokenFromHeader(req);
        if (!token) {
            return res.status(401).json({ error: "Requiere iniciar sesión" });
        }
        const user = await authService.me(token);
        if (!user) {
            return res.status(401).json({ error: "Sesión no válida" });
        }
        if (!isAdmin(user)) {
            return res.status(403).json({ error: "Acceso denegado: se requiere rol de administrador" });
        }
        req.adminUser = user;
        next();
    } catch (error) {
        res.status(500).json({ error: "Error al verificar permisos de administrador" });
    }
}

// Ejemplo de ruta solo para administradores
router.get("/admin/stats", requireAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ users: 0, movies: 0, series: 0, reviews: 0, reviewsPositive: 0, reviewsNegative: 0, reviewsByGenre: [], activity: [] });
        }
        const [usersSnap, moviesSnap, seriesSnap, reviewsSnap] = await Promise.all([
            db.collection("users").get(),
            db.collection("movies").get(),
            db.collection("series").get(),
            db.collection("reviews").limit(20000).get()
        ]);

        // ---- Reseñas por género (TODAS las reseñas, sin límite de página) ----
        // Índice imdbID -> géneros a partir del catálogo (las obras guardan su genre
        // como lista separada por comas, p. ej. "Comedy, Drama, War").
        const genreByContentKey = new Map();
        const addGenreIndex = (data, type) => {
            const imdb = String((data && data.imdbID) || "").trim().toLowerCase();
            const genre = String((data && data.genre) || "").trim();
            if (imdb && genre && genre !== "Sin género" && genre !== "N/A") {
                genreByContentKey.set(type + ":" + imdb, genre);
            }
        };
        moviesSnap.forEach((d) => addGenreIndex(d.data(), "movie"));
        seriesSnap.forEach((d) => addGenreIndex(d.data(), "series"));

        // Reseñas agrupadas por obra (mediaKey: "movie:tt4758646" / "series:tt1520211").
        const reviewsByContent = {};
        let reviewsPositive = 0;
        let reviewsNegative = 0;
        reviewsSnap.forEach((d) => {
            const data = d.data() || {};
            const key = String(data.mediaKey || "").toLowerCase();
            const rating = Number(data.rating);
            if (Number.isInteger(rating)) {
                if (rating >= 7) reviewsPositive += 1;
                else if (rating <= 4) reviewsNegative += 1;
            }
            if (!key) return;
            const entry = reviewsByContent[key] || (reviewsByContent[key] = { count: 0, positive: 0, negative: 0 });
            entry.count += 1;
            if (Number.isInteger(rating)) {
                if (rating >= 7) entry.positive += 1;
                else if (rating <= 4) entry.negative += 1;
            }
        });

        const byGenre = {};
        for (const [key, info] of Object.entries(reviewsByContent)) {
            const genreRaw = genreByContentKey.get(key);
            if (!genreRaw) continue;
            for (const part of String(genreRaw).split(",")) {
                const name = part.trim();
                if (!name) continue;
                const gk = name.toLowerCase();
                const entry = byGenre[gk] || (byGenre[gk] = { genre: name, count: 0, positive: 0, negative: 0 });
                entry.count += info.count;
                entry.positive += info.positive;
                entry.negative += info.negative;
            }
        }
        const reviewsByGenre = Object.values(byGenre)
            .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre))
            .map((g) => ({ genre: g.genre, count: g.count, positive: g.positive, negative: g.negative }));

        const activity = await ActivityModel.listRecent(8);

        res.json({
            users: usersSnap.size,
            movies: moviesSnap.size,
            series: seriesSnap.size,
            reviews: reviewsSnap.size,
            reviewsPositive,
            reviewsNegative,
            reviewsByGenre,
            activity
        });
    } catch (error) {
        res.status(500).json({ error: error.message || "Error al obtener estadísticas" });
    }
});

// Ruta para listar todos los usuarios (solo admin)
router.get("/admin/users", requireAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ users: [] });
        }
        const snapshot = await db.collection("users").get();
        const users = [];
        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            users.push({
                id: doc.id,
                name: data.name,
                email: data.email,
                role: data.role || "user",
                createdAt: data.createdAt,
                prefs: data.prefs
            });
        });
        res.json({ users });
    } catch (error) {
        res.status(500).json({ error: error.message || "Error al listar usuarios" });
    }
});

// Ruta para cambiar rol de usuario (solo admin)
router.put("/admin/users/:id/role", requireAdmin, async (req, res) => {
    try {
        const { role } = req.body || {};
        if (!role || !["user", "admin"].includes(role)) {
            return res.status(400).json({ error: "Rol inválido. Usa 'user' o 'admin'" });
        }
        if (!db) {
            return res.status(503).json({ error: "No disponible en modo local" });
        }
        const userRef = db.collection("users").doc(req.params.id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }
        await userRef.update({ role });
        // Registro de actividad: quién (el admin autenticado) cambió el rol a quién.
        const targetDoc = userDoc.data() || {};
        const actorName = (req.adminUser && (req.adminUser.name || req.adminUser.nickname)) || "Administrador";
        const targetName = targetDoc.name || targetDoc.nickname || "un usuario";
        await ActivityModel.addEvent({
            type: role === "admin" ? "promote" : "demote",
            actor: actorName,
            target: targetName
        });
        res.json({ ok: true, role });
    } catch (error) {
        res.status(500).json({ error: error.message || "Error al cambiar rol" });
    }
});

module.exports = router;
