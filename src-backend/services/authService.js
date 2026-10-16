// Firebase Authentication valida la identidad; este servicio sincroniza el perfil
// con Firestore y crea una sesión técnica para las rutas privadas.
const crypto = require("crypto");

// Conexión centralizada a Firestore (ver ../models/firebase.js).
const firebaseConn = require("../models/firebase");
const { FieldValue } = require("firebase-admin/firestore");
const db = firebaseConn.getDb();
if (!firebaseConn.isFirestoreConnected()) {
    console.warn("[auth] Sin Firestore. La autenticación Firebase no estará disponible.");
}

// Memoria para modo local.
const localUsers = new Map(); // email -> user
const localSessions = new Map(); // token -> { userId, expiresAt }

const SESSION_DAYS = 30;

// Firebase demuestra quién es el usuario; esta sesión técnica autoriza las
// operaciones de Firestore de la aplicación sin exponer credenciales Admin.
function sessionExpiry() {
    return Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
}

// Preferencias del cuestionario/perfil.
// OJO: el apodo NO va aquí. Vive en un único campo `users/{email}.nickname`
// (ver setUserNickname). Antes se duplicaba también en `prefs.nickname`, y como
// el cuestionario reescribe `prefs` con estos valores por defecto, dejaba el
// campo de prefs a null y el documento acababa con DOS campos de apodo.
function defaultPrefs() {
    return {
        favoriteGenres: [],      // máx 3, strings (ej: ["Action", "Drama", "Sci-Fi"])
        likesMovies: null,       // true | false | null
        onboardingDone: false,   // true cuando completó el cuestionario
        colorTheme: "default"    // default, vibrant, neon, pastel
    };
}

// Mismos temas que el front (COLOR_THEMES de public/js/bundle.js).
const COLOR_THEMES = ["default", "vibrant", "neon", "pastel"];

function cleanColorTheme(raw) {
    const clean = String(raw || "").trim().toLowerCase();
    return COLOR_THEMES.includes(clean) ? clean : null;
}

// ---- Roles (tarea 1: sistema de roles Admin/User) ----
// Solo existen dos roles: "user" (por defecto) y "admin".
// `role` es el campo propio. Además se acepta el booleano `isAdmin` que usa el
// resto del equipo en Firestore, para que las dos implementaciones convivan sin
// que nadie se quede sin acceso al panel.
function normalizeRole(raw) {
    return String(raw || "").trim().toLowerCase() === "admin" ? "admin" : "user";
}

function roleOfUser(user) {
    const role = String((user && user.role) || "").trim().toLowerCase();
    if (role === "admin" || role === "user") return role;
    if (user && user.isAdmin === true) return "admin";
    return "user";
}

// Se escribe siempre `role` y, por compatibilidad, también `isAdmin`.
function rolePatch(role) {
    const clean = normalizeRole(role);
    return { role: clean, isAdmin: clean === "admin" };
}

// ADMIN_EMAILS="admin@x.com,otro@y.com" en el .env: esas cuentas reciben rol
// admin al entrar. Permite crear al primer administrador sin tocar Firestore.
function bootstrapAdminEmails() {
    return new Set(
        String(process.env.ADMIN_EMAILS || "")
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
    );
}

function roleForNewUser(email) {
    return bootstrapAdminEmails().has(String(email || "").trim().toLowerCase()) ? "admin" : "user";
}

function isAdminUser(user) {
    return Boolean(user) && roleOfUser(user) === "admin";
}

// Compatibilidad con el código del equipo: su authService exporta estos mismos
// nombres (`USER_ROLES`, `hasRole`, `isAdmin`) y sus rutas los importan, así que
// los exponemos también aquí para que el merge no rompa nada.
const USER_ROLES = { USER: "user", ADMIN: "admin" };

// Temas de color disponibles en Configuración de perfil.
const USER_THEMES = ["default", "vibrant", "neon", "pastel"];

function hasRole(user, role) {
    return roleOfUser(user) === normalizeRole(role);
}

// El apodo es la identidad pública y es OPCIONAL: no debe confundirse con el
// nombre completo. Antes se devolvía `user.name` como apodo cuando no existía,
// y el front lo pintaba como "@Nombre Apellido" (apodo falso). Ahora, sin apodo
// se devuelve null y cada pantalla decide su texto de reserva.
function publicUser(user) {
    const role = roleOfUser(user);
    const prefs = { ...defaultPrefs(), ...(user.prefs || {}) };
    // Campo único: `users/{email}.nickname`. Se sigue leyendo `prefs.nickname`
    // de documentos antiguos, pero nunca se devuelve dentro de prefs.
    const nickname = String(user.nickname || prefs.nickname || "").trim() || null;
    delete prefs.nickname;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        photoURL: user.photoURL || null,
        provider: user.provider || (user.passHash ? "password" : "firebase"),
        role,
        isAdmin: role === "admin",
        nickname,
        colorTheme: prefs.colorTheme || "default",
        prefs
    };
}

// Tarjeta pública mínima de otro usuario (la usan las rutas de amistades y el
// buscador). Incluye el apodo público porque es el nombre que se muestra en la
// interfaz; nunca incluye contraseña ni sesiones.
function cardUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        nickname: (user.prefs && user.prefs.nickname) || user.nickname || null,
        photoURL: user.photoURL || null,
        provider: user.provider || null,
        role: normalizeRole(user.role),
        nickname: user.nickname || (user.prefs && user.prefs.nickname) || null
    };
}

// Ficha pública de otro usuario para el perfil social (página /perfil).
// Deja fuera el email, el rol y cualquier dato de sesión: lo que se enseña de
// alguien que no es tu amigo es su presentación, nunca su cuenta.
function socialProfile(user) {
    if (!user) return null;
    const prefs = user.prefs || {};
    return {
        id: user.id,
        name: user.name || null,
        nickname: nicknameOf(user) || null,
        photoURL: user.photoURL || null,
        provider: user.provider || null,
        favoriteGenres: Array.isArray(prefs.favoriteGenres) ? prefs.favoriteGenres.slice(0, 3) : [],
        joinedAt: user.createdAt || null
    };
}

function cleanTop5Item(item) {
    if (!item || typeof item !== "object") throw new Error("Cada favorita de la lista debe ser un objeto");
    const title = String(item.title || "").trim().slice(0, 200);
    const imdbID = String(item.imdbID || "").trim();
    if (!title && !imdbID) throw new Error("Cada favorita necesita un título o un código de contenido");
    if (imdbID && !/^tt\d+$/i.test(imdbID)) throw new Error("Código del contenido inválido en la lista de favoritas");
    const type = String(item.type || "movie").toLowerCase().trim();
    if (type !== "movie" && type !== "series") throw new Error("Tipo inválido en la lista de favoritas");
    return {
        movieId: String(item.movieId || "").trim().slice(0, 300) || null,
        imdbID: imdbID || null,
        title: title || imdbID,
        year: String(item.year || "").trim().slice(0, 9) || null,
        poster: String(item.poster || "").trim().slice(0, 500) || null,
        type
    };
}

function isAdmin(user) {
    if (!user) return false;
    // 1. Rol canónico: campo "role" del documento (lo que escribe el panel admin)
    const canonRole = user.role && String(user.role).trim().toLowerCase();
    if (canonRole === USER_ROLES.ADMIN) return true;
    // 2. Compatibilidad: role guardado en prefs (configurable en Firestore)
    const prefRole = user.prefs && user.prefs.role && String(user.prefs.role).trim().toLowerCase();
    if (prefRole === "admin") return true;
    // 3. Revisar email dominios comunes de pruebas (ej. admin@dominio.com)
    const adminEmails = ["admin@test.com", "admin@example.com"];
    if (adminEmails.includes(user.email)) return true;
    // 4. Fallback: si el apodo contiene "admin"
    if (user.nickname && user.nickname.toString().toLowerCase().includes("admin")) return true;
    return false;
}

// Hasta 5 favoritas por usuario: { movieId?, imdbID?, title, year?, poster?, type? }.
function validateTop5(items) {
    if (!Array.isArray(items)) throw new Error("'top5' debe ser un array");
    const out = [];
    for (const raw of items.slice(0, 5)) {
        if (!raw || typeof raw !== "object") continue;
        const title = String(raw.title || "").trim();
        if (!title) continue;
        out.push({
            movieId: raw.movieId ? String(raw.movieId).slice(0, 160) : null,
            imdbID: raw.imdbID ? String(raw.imdbID).slice(0, 20) : null,
            title: title.slice(0, 200),
            year: raw.year ? String(raw.year).slice(0, 4) : null,
            poster: raw.poster ? String(raw.poster).slice(0, 500) : null,
            type: raw.type ? String(raw.type).slice(0, 20) : null
        });
    }
    return out;
}

async function listStoredUsers() {
    if (!db) return [...localUsers.values()];
    const snapshot = await db.collection("users").limit(5000).get();
    return snapshot.docs.map((doc) => Object.assign({ id: doc.id }, doc.data()));
}

// ---- Nickname público (lo usa el front del equipo) ----
function nicknameOf(user) {
    if (!user) return "";
    return String(user.nickname || (user.prefs && user.prefs.nickname) || "").trim().toLowerCase();
}

function nicknameError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

async function findUserByNickname(nickname) {
    const wanted = String(nickname || "").trim().toLowerCase();
    if (!wanted) return null;
    const users = await listStoredUsers();
    return users.find((user) => nicknameOf(user) === wanted) || null;
}

function cleanDisplayName(raw, emailFallback) {
    const clean = (raw || "").toString().trim().slice(0, 80);
    if (clean.length >= 2) return clean;
    const prefix = String(emailFallback || "").split("@")[0] || "Usuario";
    return prefix.slice(0, 80) || "Usuario";
}

async function findUserByEmail(email) {
    if (!db) return localUsers.get(email) || null;
    const doc = await db.collection("users").doc(email).get();
    if (!doc.exists) return null;
    return Object.assign({ id: doc.id }, doc.data());
}

// Usuario por id (el id es el email del usuario). Sirve para las dos formas de
// guardar: memoria (clave = email) y Firestore (doc = email).
async function storedUserById(userId) {
    const key = String(userId || "").trim().toLowerCase();
    if (!key) return null;
    if (!db) {
        if (localUsers.has(key)) return localUsers.get(key);
        for (const user of localUsers.values()) {
            if (String(user.id || "").toLowerCase() === key) return user;
        }
        return null;
    }
    const doc = await db.collection("users").doc(key).get();
    if (!doc.exists) return null;
    return Object.assign({ id: doc.id }, doc.data());
}

// ---- Nickname público y color de tema (los usa el front del equipo) ----
// El nickname se guarda en el campo propio `nickname` y también dentro de
// `prefs`, porque el front lee los dos sitios.
function nicknameOf(user) {
    if (!user) return "";
    return String(user.nickname || (user.prefs && user.prefs.nickname) || "").trim().toLowerCase();
}

function nicknameError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

async function findUserByNickname(nickname) {
    const wanted = String(nickname || "").trim().toLowerCase();
    if (!wanted) return null;
    const users = await listStoredUsers();
    return users.find((user) => nicknameOf(user) === wanted) || null;
}

// Devuelve un usuario por su id (el doc id de la colección users, normalmente su email).
async function getUserById(userId) {
    if (!db) {
        for (const u of localUsers.values()) {
            if (String(u.id) === String(userId)) return u;
        }
        return null;
    }
    const doc = await db.collection("users").doc(String(userId)).get();
    if (!doc.exists) return null;
    return Object.assign({ id: doc.id }, doc.data());
}

async function setUserNickname(userId, nickname) {
    const clean = String(nickname || "").trim().toLowerCase();
    if (clean.length < 3) throw nicknameError("El apodo debe tener al menos 3 caracteres", "INVALID_NICKNAME");
    if (clean.length > 30) throw nicknameError("El apodo no puede superar 30 caracteres", "INVALID_NICKNAME");
    if (!/^[a-z0-9_.-]+$/.test(clean)) throw nicknameError("El apodo solo puede contener letras, números, guión bajo (_), guion (-) y punto (.)", "INVALID_NICKNAME");
    const owner = String(userId || "").trim().toLowerCase();
    const existing = await findUserByNickname(clean);
    if (existing && String(existing.id || "").toLowerCase() !== owner) {
        throw nicknameError("Ese apodo ya está en uso", "NICKNAME_TAKEN");
    }

    const user = await storedUserById(userId);
    if (!db) {
        if (user) {
            user.nickname = clean;
            localUsers.set(String(user.email || owner).toLowerCase(), user);
        }
        return clean;
    }
    // Un único campo: `users/{email}.nickname`. `prefs` ya no guarda el apodo.
    await db.collection("users").doc(String(userId)).set({ nickname: clean }, { merge: true });
    return clean;
}

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const session = { userId, createdAt: new Date().toISOString(), expiresAt: sessionExpiry() };
    if (!db) {
        localSessions.set(token, session);
    } else {
        await db.collection("sessions").doc(token).set(session);
    }
    return token;
}

async function readSession(token) {
    if (!token) return null;
    let session = null;
    if (!db) {
        session = localSessions.get(token) || null;
    } else {
        const doc = await db.collection("sessions").doc(token).get();
        if (doc.exists) session = doc.data();
    }
    if (!session) return null;
    if (session.expiresAt && session.expiresAt < Date.now()) {
        await deleteSession(token);
        return null;
    }
    return session;
}

async function deleteSession(token) {
    if (!token) return;
    if (!db) {
        localSessions.delete(token);
    } else {
        try {
            await db.collection("sessions").doc(token).delete();
        } catch (e) {
            /*logout best-effort*/
        }
    }
}

// Guarda el objeto completo de preferencias sin perder lo que ya había.
// (updateUserPrefs sustituye el objeto entero y está pensado para el cuestionario.)
async function saveUserPrefs(userId, prefs) {
    if (!db) {
        const user = localUsers.get(userId);
        if (user) {
            user.prefs = prefs;
            localUsers.set(userId, user);
        }
        return prefs;
    }
    await db.collection("users").doc(String(userId)).set({ prefs }, { merge: true });
    return prefs;
}

async function updateUserPrefs(userId, prefs) {
    const merged = { ...defaultPrefs(), ...prefs };
    // Defensa: el apodo nunca se guarda en prefs. Así el cuestionario (que
    // reescribe prefs entero) no puede borrarlo ni recrear el campo duplicado.
    delete merged.nickname;
    if (!db) {
        const u = localUsers.get(userId);
        if (u) {
            u.prefs = merged;
            localUsers.set(userId, u);
        }
        return merged;
    }
    await db.collection("users").doc(userId).set(
        { prefs: merged, "prefs.nickname": FieldValue.delete() },
        { merge: true }
    );
    return merged;
}

const authService = {
    // Recibe el ID token del navegador, lo verifica con Admin y sincroniza el
    // perfil local antes de devolver la sesión técnica de la aplicación.
    loginWithFirebase: async ({ idToken, name }) => {
        const adminAuth = firebaseConn.getAuth();
        if (!adminAuth) {
            const err = new Error("Firebase Auth no configurado en el servidor (faltan credenciales de la cuenta de servicio)");
            err.code = "FIREBASE_NOT_CONFIGURED";
            throw err;
        }
        if (!idToken || typeof idToken !== "string" || idToken.length < 20) {
            const err = new Error("ID token de Firebase requerido");
            err.code = "INVALID_FIREBASE_TOKEN";
            throw err;
        }
        let decoded;
        try {
            decoded = await adminAuth.verifyIdToken(idToken);
        } catch (e) {
            const err = new Error("Sesión de Firebase no válida o caducada. Vuelve a entrar.");
            err.code = "INVALID_FIREBASE_TOKEN";
            throw err;
        }
        const email = String(decoded.email || "").trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            const err = new Error("La cuenta de Firebase no tiene un correo válido");
            err.code = "INVALID_FIREBASE_TOKEN";
            throw err;
        }
        const provider = (decoded.firebase && decoded.firebase.sign_in_provider) || "firebase";
        const displayName = cleanDisplayName(name || decoded.name, email);

        let user = await findUserByEmail(email);
        if (!user) {
            user = {
                id: email,
                name: displayName,
                email: email,
                passHash: null,
                provider: provider,
                firebaseUid: decoded.uid || null,
                photoURL: decoded.picture || null,
                emailVerified: Boolean(decoded.email_verified),
                ...rolePatch(roleForNewUser(email)),
                prefs: defaultPrefs(),
                createdAt: new Date().toISOString()
            };
            if (!db) {
                localUsers.set(email, user);
            } else {
                await db.collection("users").doc(email).set(user);
            }
        } else {
            // Enlaza cuentas legacy (email+password propio) con Firebase si comparten email.
            const patch = {};
            if (!user.firebaseUid && decoded.uid) patch.firebaseUid = decoded.uid;
            if (!user.provider) patch.provider = user.passHash ? "password" : provider;
            if ((!user.name || user.name.length < 2) && displayName) patch.name = displayName;
            if (!user.photoURL && decoded.picture) patch.photoURL = decoded.picture;
            // Backfill de rol para cuentas creadas antes de existir roles.
            // Si el usuario ya tiene isAdmin:true (campo del equipo) se respeta.
            if (!user.role) Object.assign(patch, rolePatch(user.isAdmin === true ? "admin" : roleForNewUser(email)));
            if (Object.keys(patch).length > 0) {
                Object.assign(user, patch);
                if (!db) {
                    localUsers.set(email, user);
                } else {
                    await db.collection("users").doc(email).set(patch, { merge: true });
                }
            }
        }

        const token = await createSession(user.id);
        return { token, user: publicUser(user) };
    },

    logout: async (token) => {
        await deleteSession(token);
        return true;
    },

    me: async (token) => {
        const session = await readSession(token);
        if (!session) return null;
        let user = null;
        if (!db) {
            for (const u of localUsers.values()) {
                if (u.id === session.userId) {
                    user = u;
                    break;
                }
            }
        } else {
            const doc = await db.collection("users").doc(session.userId).get();
            if (doc.exists) user = Object.assign({ id: doc.id }, doc.data());
        }
        if (!user) {
            await deleteSession(token);
            return null;
        }
        return publicUser(user);
    },

    // Actualiza preferencias (cuestionario onboarding)
    updatePrefs: async (token, prefs) => {
        const session = await readSession(token);
        if (!session) return null;
        const merged = await updateUserPrefs(session.userId, prefs);
        return merged;
    },

    // ---- Perfil público: apodo único + tema (PUT /api/auth/profile) ----
    // El apodo se valida y se reserva con setUserNickname (único y normalizado);
    // el tema se guarda en prefs. Devuelve las prefs resultantes.
    updateProfile: async (token, { nickname, colorTheme } = {}) => {
        const session = await readSession(token);
        if (!session) return null;

        let savedNickname = null;
        if (nickname !== undefined && nickname !== null && String(nickname).trim() !== "") {
            savedNickname = await setUserNickname(session.userId, nickname);
        }

        const user = await storedUserById(session.userId);
        const prefs = { ...defaultPrefs(), ...(user && user.prefs) };
        // El apodo solo vive en `users/{email}.nickname`: no se copia a prefs.
        delete prefs.nickname;
        const theme = cleanColorTheme(colorTheme);
        if (theme) prefs.colorTheme = theme;

        return updateUserPrefs(session.userId, prefs);
    },

    // ---- Usuarios (amistades, Top 5 y administración) ----

    getById: async (id) => storedUserById(id),

    // Perfil público (página /perfil): presentación del usuario, sin email ni
    // datos de sesión. Lo usan las rutas de perfil, que antes llamaban a un
    // método inexistente y respondían 500: por eso el perfil público no cargaba.
    getPublicProfile: async (id) => {
        const user = await authService.getById(id);
        return socialProfile(user);
    },

    setTop5strict: async (userId, items) => {
        if (!userId || !Array.isArray(items)) throw new Error("Lista de favoritas inválida");
        const top5 = items.slice(0, 5).map(cleanTop5Item);
        if (!db) {
            const user = localUsers.get(userId);
            if (user) {
                user.top5 = top5;
                localUsers.set(userId, user);
            }
            return top5;
        }
        await db.collection("users").doc(userId).set({ top5 }, { merge: true });
        return top5;
    },
    // Sesión técnica a partir del token (la usan las rutas de auth/nickname).
    readSession: async (token) => readSession(token),

    // Busca usuarios por nombre o email (para añadir amigos).
    searchUsers: async (query, { excludeId, limit } = {}) => {
        const q = String(query || "").trim().toLowerCase();
        const max = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 50);
        const exclude = excludeId ? String(excludeId).trim().toLowerCase() : null;
        const users = await listStoredUsers();
        return users
            .filter((user) => user && user.id)
            .filter((user) => String(user.id).toLowerCase() !== exclude)
            .filter((user) => {
                if (!q) return true;
                return String(user.name || "").toLowerCase().includes(q)
                    || nicknameOf(user).includes(q)
                    || String(user.email || "").toLowerCase().includes(q)
                    || String(user.id).toLowerCase().includes(q)
                    || String(user.nickname || (user.prefs && user.prefs.nickname) || "").toLowerCase().includes(q);
            })
            .slice(0, max)
            .map(cardUser);
    },

    // Listado paginado de usuarios para el panel de administración.
    listUsers: async ({ q, role, page, limit } = {}) => {
        const query = String(q || "").trim().toLowerCase();
        const wantedRole = role ? normalizeRole(role) : null;
        const pageNum = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), 1000);
        const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
        const users = await listStoredUsers();
        const filtered = users.filter((user) => {
            if (!user || !user.id) return false;
            if (wantedRole && normalizeRole(user.role) !== wantedRole) return false;
            if (!query) return true;
            return String(user.name || "").toLowerCase().includes(query)
                || String(user.email || "").toLowerCase().includes(query)
                || String(user.id).toLowerCase().includes(query);
        });
        filtered.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "es"));
        const byRole = filtered.reduce((acc, user) => {
            const key = normalizeRole(user.role);
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, { admin: 0, user: 0 });
        const start = (pageNum - 1) * pageSize;
        return {
            results: filtered.slice(start, start + pageSize).map(publicUser),
            total: filtered.length,
            page: pageNum,
            limit: pageSize,
            byRole
        };
    },

    countUsers: async () => {
        if (!db) return localUsers.size;
        try {
            const snap = await db.collection("users").count().get();
            return snap.data().count;
        } catch (e) {
            const snap = await db.collection("users").limit(5000).get();
            return snap.size;
        }
    },

    // Cambia el rol de un usuario (solo lo llaman las rutas de admin).
    setRole: async (id, role) => {
        const key = String(id || "").trim().toLowerCase();
        if (!key) throw new Error("Falta el usuario");
        const clean = String(role || "").trim().toLowerCase();
        if (clean !== "admin" && clean !== "user") throw new Error("Rol inválido (usa 'admin' o 'user')");
        const user = await authService.getById(key);
        if (!user) return null;
        // Se guarda `role` y también `isAdmin` para que lo lea el resto del equipo.
        const patch = rolePatch(clean);
        if (!db) {
            Object.assign(user, patch);
            localUsers.set(key, user);
        } else {
            await db.collection("users").doc(key).set(patch, { merge: true });
        }
        return publicUser({ ...user, ...patch });
    },

    getTop5: async (id) => {
        const user = await authService.getById(id);
        if (!user || !Array.isArray(user.top5)) return [];
        return user.top5;
    },

    setTop5: async (id, items) => {
        const key = String(id || "").trim().toLowerCase();
        if (!key) throw new Error("Falta el usuario");
        const clean = validateTop5(items);
        if (!db) {
            const user = localUsers.get(key);
            if (!user) return [];
            user.top5 = clean;
            localUsers.set(key, user);
            return clean;
        }
        await db.collection("users").doc(key).set({ top5: clean }, { merge: true });
        return clean;
    },

    // Busca usuarios por nombre/apodo (para a├▒adir amigos)
    // Sistema de seguimiento (follow/unfollow)
    followUser: async (token, targetUserId) => {
        const session = await readSession(token);
        if (!session) return null;
        if (session.userId === targetUserId) throw new Error("No puedes seguirte a ti mismo");

        if (!db) {
            const me = localUsers.get(session.userId);
            const target = localUsers.get(targetUserId);
            if (!me || !target) throw new Error("Usuario no encontrado");
            me.following = me.following || [];
            target.followers = target.followers || [];
            if (!me.following.includes(targetUserId)) me.following.push(targetUserId);
            if (!target.followers.includes(session.userId)) target.followers.push(session.userId);
            localUsers.set(session.userId, me);
            localUsers.set(targetUserId, target);
            return { ok: true };
        }

        const meRef = db.collection("users").doc(session.userId);
        const targetRef = db.collection("users").doc(targetUserId);

        await db.runTransaction(async (transaction) => {
            const meDoc = await transaction.get(meRef);
            const targetDoc = await transaction.get(targetRef);
            if (!meDoc.exists || !targetDoc.exists) throw new Error("Usuario no encontrado");

            const meData = meDoc.data();
            const targetData = targetDoc.data();

            const following = meData.following || [];
            const followers = targetData.followers || [];

            if (!following.includes(targetUserId)) {
                following.push(targetUserId);
                transaction.update(meRef, { following });
            }
            if (!followers.includes(session.userId)) {
                followers.push(session.userId);
                transaction.update(targetRef, { followers });
            }
        });
        return { ok: true };
    },

    unfollowUser: async (token, targetUserId) => {
        const session = await readSession(token);
        if (!session) return null;
        if (session.userId === targetUserId) throw new Error("No puedes dejar de seguirte a ti mismo");

        if (!db) {
            const me = localUsers.get(session.userId);
            const target = localUsers.get(targetUserId);
            if (!me || !target) throw new Error("Usuario no encontrado");
            me.following = (me.following || []).filter((id) => id !== targetUserId);
            target.followers = (target.followers || []).filter((id) => id !== session.userId);
            localUsers.set(session.userId, me);
            localUsers.set(targetUserId, target);
            return { ok: true };
        }

        const meRef = db.collection("users").doc(session.userId);
        const targetRef = db.collection("users").doc(targetUserId);

        await db.runTransaction(async (transaction) => {
            const meDoc = await transaction.get(meRef);
            const targetDoc = await transaction.get(targetRef);
            if (!meDoc.exists || !targetDoc.exists) throw new Error("Usuario no encontrado");

            const meData = meDoc.data();
            const targetData = targetDoc.data();

            const following = (meData.following || []).filter((id) => id !== targetUserId);
            const followers = (targetData.followers || []).filter((id) => id !== session.userId);

            transaction.update(meRef, { following });
            transaction.update(targetRef, { followers });
        });
        return { ok: true };
    },

    getFollowing: async (token) => {
        const session = await readSession(token);
        if (!session) return null;
        let user = null;
        if (!db) {
            user = localUsers.get(session.userId);
        } else {
            const doc = await db.collection("users").doc(session.userId).get();
            if (doc.exists) user = Object.assign({ id: doc.id }, doc.data());
        }
        if (!user) return [];

        const followingIds = user.following || [];
        if (followingIds.length === 0) return [];

        let followingUsers = [];
        if (!db) {
            for (const id of followingIds) {
                const u = localUsers.get(id);
                if (u) followingUsers.push(publicUser(u));
            }
        } else {
            const snapshot = await db.collection("users").where("__name__", "in", followingIds).get();
            snapshot.forEach((doc) => {
                followingUsers.push(publicUser(Object.assign({ id: doc.id }, doc.data())));
            });
        }
        return followingUsers;
    },

    getFollowers: async (token) => {
        const session = await readSession(token);
        if (!session) return null;
        let user = null;
        if (!db) {
            user = localUsers.get(session.userId);
        } else {
            const doc = await db.collection("users").doc(session.userId).get();
            if (doc.exists) user = Object.assign({ id: doc.id }, doc.data());
        }
        if (!user) return [];

        const followerIds = user.followers || [];
        if (followerIds.length === 0) return [];

        let followerUsers = [];
        if (!db) {
            for (const id of followerIds) {
                const u = localUsers.get(id);
                if (u) followerUsers.push(publicUser(u));
            }
        } else {
            const snapshot = await db.collection("users").where("__name__", "in", followerIds).get();
            snapshot.forEach((doc) => {
                followerUsers.push(publicUser(Object.assign({ id: doc.id }, doc.data())));
            });
        }
        return followerUsers;
    },

    getUserMovies: async (userId) => {
        if (!userId) return [];
        const { MovieModel } = require("../models/movieModel");
        return MovieModel.getAllMovies(userId);
    },

    getUserSeries: async (userId) => {
        if (!userId) return [];
        const { SeriesModel } = require("../models/seriesModel");
        return SeriesModel.getAllSeries(userId);
    },

    isFollowing: async (token, targetUserId) => {
        const session = await readSession(token);
        if (!session) return false;
        let user = null;
        if (!db) {
            user = localUsers.get(session.userId);
        } else {
            const doc = await db.collection("users").doc(session.userId).get();
            if (doc.exists) user = Object.assign({ id: doc.id }, doc.data());
        }
        if (!user) return false;
        return (user.following || []).includes(targetUserId);
    },

    // ---- Ayuda para desarrollo/pruebas ----
    // Crea (o reutiliza) un usuario local y una sesión sin Firebase. Solo
    // funciona en modo local: con Firestore conectado lanza NOT_LOCAL_MODE.
    seedLocalUser: async ({ email, name, role } = {}) => {
        if (db) {
            const err = new Error("seedLocalUser solo está disponible en modo local (sin Firestore)");
            err.code = "NOT_LOCAL_MODE";
            throw err;
        }
        const cleanEmail = String(email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) throw new Error("Email inválido");
        const existing = localUsers.get(cleanEmail);
        const user = existing || {
            id: cleanEmail,
            name: String(name || cleanEmail.split("@")[0]).slice(0, 80),
            email: cleanEmail,
            passHash: null,
            provider: "local",
            prefs: defaultPrefs(),
            createdAt: new Date().toISOString()
        };
        if (name) user.name = String(name).slice(0, 80);
        user.role = role ? normalizeRole(role) : normalizeRole(user.role || roleForNewUser(cleanEmail));
        localUsers.set(cleanEmail, user);
        const token = await createSession(user.id);
        return { token, user: publicUser(user) };
    }
};

module.exports = {
    authService,
    cardUser,
    socialProfile,
    isAdminUser,
    isAdmin,
    hasRole,
    USER_ROLES,
    findUserByNickname,
    setUserNickname,
    getUserById,
    nicknameOf,
    listStoredUsers,
    validateTop5,
    readSession
};
