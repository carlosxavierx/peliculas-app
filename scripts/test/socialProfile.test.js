// Pruebas del perfil público y de la amistad que lo alimenta (tarea del perfil
// clicable desde Buscar y Amistades).
//
// Igual que el resto de pruebas, se ejecuta en modo local (memoria) sin tocar
// Firestore: DISABLE_FIREBASE=1 evita cualquier conexión real. Se levanta la app
// completa y se llama por HTTP, de modo que se prueba exactamente lo que el
// navegador recibe al abrir /perfil?id=usuario.
//
//   npm test

process.env.DISABLE_FIREBASE = "1";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../../server");
const { authService } = require("../../src-backend/services/authService");
const { MovieModel } = require("../../src-backend/models/movieModel");
const { SeriesModel } = require("../../src-backend/models/seriesModel");

let server;
let baseUrl;

let ana;    // usuaria que mira perfiles
let bruno;  // no amigo al principio
let carla;  // amiga aceptada al arrancar

async function api(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let parsed = null;
    try {
        parsed = await res.json();
    } catch (e) {
        parsed = null;
    }
    return { status: res.status, body: parsed };
}

function userId(user) {
    return encodeURIComponent(user.user.id);
}

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    ana = await authService.seedLocalUser({ email: "ana.test@example.com", name: "Ana Torres" });
    bruno = await authService.seedLocalUser({ email: "bruno.test@example.com", name: "Bruno Díaz" });
    carla = await authService.seedLocalUser({ email: "carla.test@example.com", name: "Carla Ruiz" });

    // Apodos públicos: los usan la búsqueda y la ficha del perfil.
    await api("POST", "/api/auth/nickname", { token: ana.token, body: { nickname: "ana_t" } });
    await api("POST", "/api/auth/nickname", { token: bruno.token, body: { nickname: "bruno_d" } });
    await api("POST", "/api/auth/nickname", { token: carla.token, body: { nickname: "carla_r" } });

    // Colección y Top 5 de Ana: el perfil público los enseña tal cual.
    await MovieModel.saveToDatabase({ title: "Alien", year: "1979", type: "movie", imdbID: "tt0078748" }, ana.user.id);
    await SeriesModel.saveToDatabase({ title: "The Bear", year: "2022", type: "series", imdbID: "tt14452776" }, ana.user.id);
    const top5 = await api("PUT", "/api/users/me/top5", {
        token: ana.token,
        body: { top5: [{ title: "Alien", year: "1979", imdbID: "tt0078748", type: "movie" }] }
    });
    assert.equal(top5.status, 200);

    // Ana y Carla ya son amigas antes de empezar: el perfil debe notarlo.
    const request = await api("POST", "/api/auth/friends/request", { token: ana.token, body: { to: carla.user.id } });
    assert.equal(request.status, 201);
    const accepted = await api("POST", "/api/auth/friends/request/accept", {
        token: carla.token,
        body: { requestId: request.body.request.id }
    });
    assert.equal(accepted.status, 200);
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

test("la ficha pública sale sin email ni datos de la cuenta", async () => {
    const res = await api("GET", `/api/users/${userId(ana)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, "ana.test@example.com");
    assert.equal(res.body.user.name, "Ana Torres");
    assert.equal(res.body.user.nickname, "ana_t");
    assert.equal(res.body.user.email, undefined);
    assert.equal(res.body.user.prefs, undefined);
    assert.ok(Array.isArray(res.body.user.favoriteGenres));
});

test("un usuario que no existe responde 404", async () => {
    const res = await api("GET", "/api/users/nadie.test@example.com");
    assert.equal(res.status, 404);
});

test("el perfil público sirve películas, series, Top 5 y maratones", async () => {
    const id = userId(ana);

    const movies = await api("GET", `/api/users/${id}/movies`);
    assert.equal(movies.status, 200);
    assert.deepEqual(movies.body.movies.map((m) => m.title), ["Alien"]);

    const series = await api("GET", `/api/users/${id}/series`);
    assert.equal(series.status, 200);
    assert.deepEqual(series.body.series.map((s) => s.title), ["The Bear"]);

    const top5 = await api("GET", `/api/users/${id}/top5`);
    assert.equal(top5.status, 200);
    assert.equal(top5.body.top5.length, 1);
    assert.equal(top5.body.top5[0].title, "Alien");

    const marathons = await api("GET", `/api/users/${id}/marathons`);
    assert.equal(marathons.status, 200);
    assert.deepEqual(marathons.body.marathons, []);
    assert.ok(marathons.body.stats);
});

test("el Top 5 sigue disponible para la sesión propia (ruta \"me\")", async () => {
    const res = await api("GET", "/api/users/me/top5", { token: ana.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.top5.length, 1);
    assert.equal(res.body.top5[0].title, "Alien");

    const anonymous = await api("GET", "/api/users/me/top5");
    assert.equal(anonymous.status, 401);
});

test("la relación de amistad recorre todos sus estados y exige sesión", async () => {
    const anonymous = await api("GET", `/api/users/${userId(bruno)}/relationship`);
    assert.equal(anonymous.status, 401);

    const self = await api("GET", `/api/users/${userId(ana)}/relationship`, { token: ana.token });
    assert.equal(self.status, 200);
    assert.equal(self.body.status, "self");

    const none = await api("GET", `/api/users/${userId(bruno)}/relationship`, { token: ana.token });
    assert.equal(none.body.status, "none");
    assert.equal(none.body.requestId, null);

    // Ana envía la solicitud por id (no por apodo) y cada lado ve su estado.
    const sent = await api("POST", "/api/auth/friends/request", { token: ana.token, body: { to: bruno.user.id } });
    assert.equal(sent.status, 201);
    const requestId = sent.body.request.id;

    const asSender = await api("GET", `/api/users/${userId(bruno)}/relationship`, { token: ana.token });
    assert.equal(asSender.body.status, "request-sent");
    assert.equal(asSender.body.requestId, requestId);

    const asReceiver = await api("GET", `/api/users/${userId(ana)}/relationship`, { token: bruno.token });
    assert.equal(asReceiver.body.status, "request-received");
    assert.equal(asReceiver.body.requestId, requestId);

    // La solicitud aparece en la bandeja de enviadas con el apodo del destino.
    const sentList = await api("GET", "/api/auth/friends/requests/sent", { token: ana.token });
    assert.equal(sentList.status, 200);
    assert.equal(sentList.body.requests.length, 1);
    assert.equal(sentList.body.requests[0].request.id, requestId);
    assert.equal(sentList.body.requests[0].toUser.nickname, "bruno_d");

    // Bruno acepta: la relación queda en amigos para los dos.
    const accepted = await api("POST", "/api/auth/friends/request/accept", {
        token: bruno.token,
        body: { requestId }
    });
    assert.equal(accepted.status, 200);
    for (const token of [ana.token, bruno.token]) {
        const other = token === ana.token ? userId(bruno) : userId(ana);
        const relation = await api("GET", `/api/users/${other}/relationship`, { token });
        assert.equal(relation.body.status, "friends");
    }

    // Si se elimina la amistad, el perfil vuelve a ofrecer añadir.
    const removed = await api("DELETE", `/api/auth/friends/${userId(bruno)}`, { token: ana.token });
    assert.equal(removed.status, 200);
    const afterRemove = await api("GET", `/api/users/${userId(bruno)}/relationship`, { token: ana.token });
    assert.equal(afterRemove.body.status, "none");
});

test("una solicitud enviada se puede cancelar desde el perfil", async () => {
    const created = await api("POST", "/api/auth/friends/request", { token: carla.token, body: { to: bruno.user.id } });
    assert.equal(created.status, 201);
    const requestId = created.body.request.id;

    const pending = await api("GET", `/api/users/${userId(bruno)}/relationship`, { token: carla.token });
    assert.equal(pending.body.status, "request-sent");

    const cancelled = await api("DELETE", `/api/auth/friends/request/${encodeURIComponent(requestId)}`, { token: carla.token });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.ok, true);

    const afterCancel = await api("GET", `/api/users/${userId(bruno)}/relationship`, { token: carla.token });
    assert.equal(afterCancel.body.status, "none");

    // Nadie más puede cancelar una solicitud ajena.
    const foreign = await api("POST", "/api/auth/friends/request", { token: carla.token, body: { to: bruno.user.id } });
    assert.equal(foreign.status, 201);
    const stolen = await api("DELETE", `/api/auth/friends/request/${encodeURIComponent(foreign.body.request.id)}`, { token: ana.token });
    assert.equal(stolen.status, 403);
});

test("el buscador encuentra por apodo, nombre o correo y avisa de la amistad", async () => {
    const friend = await api("GET", "/api/users/search?q=carla_r", { token: ana.token });
    assert.equal(friend.status, 200);
    const carlaCard = friend.body.users.find((u) => u.id === "carla.test@example.com");
    assert.ok(carlaCard, "el apodo debe encontrar a Carla");
    assert.equal(carlaCard.nickname, "carla_r");
    assert.equal(carlaCard.relationship, "friends");

    const byName = await api("GET", "/api/users/search?q=bruno", { token: ana.token });
    const brunoCard = byName.body.users.find((u) => u.id === "bruno.test@example.com");
    assert.ok(brunoCard, "el nombre debe encontrar a Bruno");
    assert.equal(brunoCard.relationship, "none");

    const byEmail = await api("GET", "/api/users/search?q=bruno.test@", { token: ana.token });
    assert.ok(byEmail.body.users.some((u) => u.id === "bruno.test@example.com"));

    // Nunca me devuelvo a mí misma en la búsqueda.
    const self = await api("GET", "/api/users/search?q=ana", { token: ana.token });
    assert.equal(self.body.users.some((u) => u.id === "ana.test@example.com"), false);

    // Sin sesión el buscador no está disponible.
    const anonymous = await api("GET", "/api/users/search?q=bruno");
    assert.equal(anonymous.status, 401);
});
