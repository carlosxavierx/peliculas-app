/**
 * Crea N reseñas para obras del catálogo directamente en Firestore.
 * Pensado para incrementar los datos de prueba del panel de administración
 * (reseñas, estadísticas, sentimiento, géneros).
 *
 * Uso:
 *   node scripts/seedReviews.js                 # 100 reseñas por obra
 *   node scripts/seedReviews.js --count=100
 *   node scripts/seedReviews.js --count=50 --dry-run   # solo simula, no escribe
 *
 * Requiere credenciales Firebase Admin en .env (igual que el resto del backend).
 *
 * Notas:
 *  - El modelo solo permite UNA reseña por usuario y obra (REVIEW_DUPLICATE),
 *    por eso se generan tantos usuarios ficticios como reseñas se pidan.
 *  - El rating se deriva del grupo del texto (positiva/neutra/negativa),
 *    porque el modelo NO tiene un clasificador de sentimiento (classify).
 */

const firebaseConn = require("../src-backend/models/firebase");
const { ReviewModel } = require("../src-backend/models/reviewModel");

const db = firebaseConn.getDb();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const countArg = args.find((arg) => arg.startsWith("--count="));
const reviewsPerMedia = countArg ? Number.parseInt(countArg.split("=")[1], 10) : 100;

if (!db) {
    console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
    process.exit(1);
}

// IMDB IDs de contenido que SÍ existe en el catálogo (visible en el buscador del admin).
const MEDIA = [
    {
        mediaType: "movie",
        imdbID: "tt4758646",
        title: "War Machine",
        year: 2017
    },
    {
        mediaType: "series",
        imdbID: "tt1520211",
        title: "The Walking Dead",
        year: 2010
    }
];

// Grupos: 10 positivas, 10 neutras, 10 negativas. Todas cumplen el mínimo de 50 caracteres.
const REVIEWS = [
    // -- positivas --
    { label: "positive", text: "Una obra maestra absoluta. La dirección, la fotografía y los efectos visuales están a otro nivel. Me dejó sin palabras." },
    { label: "positive", text: "De las mejores películas o series que he visto en años. La historia te atrapa desde el primer minuto y no te suelta." },
    { label: "positive", text: "Increíble construcción de mundo y personajes memorables. El guion es inteligente y respeta al espectador." },
    { label: "positive", text: "Visual y narrativamente impresionante. Cada escena está cuidada al detalle. Un 10 sobre 10 sin ninguna duda." },
    { label: "positive", text: "Me encantó cómo desarrolla sus temas sin ser pretenciosa. Entretenida, profunda y emocionante a la vez." },
    { label: "positive", text: "Los efectos especiales son revolucionarios, pero lo mejor es el corazón de la historia. Muy recomendable." },
    { label: "positive", text: "Una experiencia audiovisual única. Se nota el cariño y el trabajo detrás de cada decisión creativa." },
    { label: "positive", text: "Superó todas mis expectativas. El reparto está perfecto y la banda sonora eleva cada escena." },
    { label: "positive", text: "Pocas veces se ve algo tan ambicioso y bien ejecutado. Un referente en su género para las próximas décadas." },
    { label: "positive", text: "Emocionante, visualmente espectacular y con una historia que resuena. Cine de la buena, de principio a fin." },
    // -- neutras --
    { label: "neutral", text: "Entretenida y bien hecha, aunque no me cambió la vida. Cumple lo que promete sin más ni menos." },
    { label: "neutral", text: "Tiene momentos brillantes y otros que se sienten de relleno. En conjunto, una experiencia correcta." },
    { label: "neutral", text: "Buena producción y actuaciones sólidas, pero el guion a veces cae en tópicos muy conocidos." },
    { label: "neutral", text: "Visualmente impresionante, aunque la historia me resultó predecible en varios puntos." },
    { label: "neutral", text: "Me gustó, pero esperaba más profundidad en los personajes secundarios. Aun así, se deja ver bien." },
    { label: "neutral", text: "Correcta, con buen ritmo y producción de calidad. No es nada del otro mundo pero entretiene." },
    { label: "neutral", text: "Tiene sus altibajos. Cuando brilla, brilla mucho; cuando falla, se nota. Un promedio notable." },
    { label: "neutral", text: "Una propuesta sólida que sabe a qué juega. No innova pero ejecuta bien sus ideas." },
    { label: "neutral", text: "Disfrutable sin ser memorable. Buena para una tarde de desconexión total, sin más pretensiones." },
    { label: "neutral", text: "Bien hecha técnicamente, aunque le falta ese algo que la haga especial. Aprobada sin entusiasmo." },
    // -- negativas --
    { label: "negative", text: "Visualmente bonita pero vacía de contenido. Mucho ruido y pocas nueces. Me aburrí en varios tramos." },
    { label: "negative", text: "Sobrevalorada. Los efectos no pueden salvar un guion plano y unos personajes de cartón." },
    { label: "negative", text: "Se arrastra demasiado. Podrían haber contado lo mismo en la mitad de tiempo sin perder nada." },
    { label: "negative", text: "Prometía mucho y decepciona. Los giros de guion son forzados y el final no convence nada." },
    { label: "negative", text: "Demasiado estilo y poca sustancia. Parece hecha para impresionar técnicamente, no para contar una historia." },
    { label: "negative", text: "Los personajes toman decisiones ilógicas solo para avanzar la trama. Me saca de la inmersión." },
    { label: "negative", text: "Empezó fuerte pero se desinfló rápido. La segunda mitad se siente como relleno innecesario." },
    { label: "negative", text: "No entendí la fama. Para mí es un producto correcto pero sin alma ni ningún riesgo creativo." },
    { label: "negative", text: "Abusa de los clichés del género sin aportar nada nuevo. Una oportunidad completamente perdida." },
    { label: "negative", text: "Bonito envoltorio, regalo decepcionante. No la recomendaría salvo para ver efectos visuales." }
];

function getRandomRating(label) {
    if (label === "positive") return Math.floor(Math.random() * 3) + 8; // 8-10
    if (label === "negative") return Math.floor(Math.random() * 4) + 1; // 1-4
    return Math.floor(Math.random() * 3) + 5; // 5-7
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Engendra el número exacto de usuarios ficticios para respetar la regla
// "una reseña por usuario y obra" sin colisiones (RESEÑA duplicada).
function makeUsers(count) {
    const users = [];
    for (let i = 0; i < count; i++) {
        const n = String(i + 1).padStart(4, "0");
        users.push({
            userId: `seed_user_${n}`,
            userName: `Cinefilo Seed ${n}`
        });
    }
    return users;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Nombres reales ----------
// Generador determinista de nombres y apellidos en español para que las reseñas
// del panel no parezcan de una base de pruebas (en lugar de "Cinefilo Seed NNNN").
const FIRST_NAMES = [
    "Lucía", "Martín", "Sofía", "Hugo", "Valeria", "Daniel", "Paula", "Alejandro",
    "Claudia", "Diego", "Marta", "Iván", "Nerea", "Álvaro", "Carla", "Javier",
    "Elena", "Pablo", "Rocío", "Sergio", "Laura", "Raúl", "Cristina", "Andrés",
    "Nuria", "Miguel", "Sara", "Rubén", "Patricia", "Óscar", "Alba", "Fernando",
    "Teresa", "Adrián", "Irene", "Jorge", "Silvia", "David", "Ana", "Carlos",
    "María", "Jesús", "Celia", "Luis", "Inés", "Manuel", "Alicia", "Pedro",
    "Carmen", "Antonio", "Beatriz", "Francisco", "Esther", "Juan", "Victoria",
    "Ricardo", "Mónica", "Santiago", "Gloria", "Ramiro", "Verónica", "Salvador",
    "Pilar", "Emilio", "Susana", "Félix", "Rosa", "Leandro", "Miriam", "Gonzalo",
    "Tania", "Joaquín", "Olga", "Marcos", "Natalia", "Héctor", "Rebeca", "Iker",
    "Lorena", "Aitor", "Ariadna", "Unai", "Noelia", "Iago", "Camila", "Bruno",
    "Fátima", "Leo", "Jimena", "Marco", "Elsa", "Gael", "Renata", "Nicolás",
    "Valentina", "Samuel", "Andrea", "Emiliano", "Bianca", "Matías", "Daniela"
];
const LAST_NAMES = [
    "García", "Rodríguez", "González", "Fernández", "López", "Martínez", "Sánchez",
    "Pérez", "Gómez", "Martín", "Ruiz", "Hernández", "Díaz", "Moreno", "Muñoz",
    "Álvarez", "Romero", "Alonso", "Gutiérrez", "Navarro", "Torres", "Domínguez",
    "Vázquez", "Ramos", "Gil", "Ramírez", "Serrano", "Blanco", "Molina", "Morales",
    "Suárez", "Ortega", "Delgado", "Castro", "Ortiz", "Rubio", "Marín", "Sanz",
    "Iglesias", "Medina", "Garrido", "Cortés", "Castillo", "Santos", "Lozano",
    "Guerrero", "Cano", "Prieto", "Méndez", "Cruz", "Calvo", "Gallego", "Vidal",
    "León", "Márquez", "Peña", "Durán", "Vega", "Fuentes", "Cabrera", "Carrasco",
    "Soto", "Herrera", "Aguilar", "Flores", "Reyes", "Campos", "Sáez", "Arias",
    "Vargas", "Mora", "Rojas", "Parra", "Bravo", "Jiménez", "Salas", "Ríos",
    "Nieto", "Casado", "Rivas", "Guzmán", "Pereira", "Aparicio", "Cabello",
    "Vicente", "Ibáñez", "Benítez", "Aguirre", "Toledo", "Pastor", "Montero",
    "Santana", "Prado", "Escobar", "Maldonado", "Quintana", "Zapata", "Camacho", "Aranda"
];

// Devuelve un nombre completo (nombre + apellido) en función de un índice (1..N).
// El apellido usa un multiplicador coprimo con el nº de apellidos para repartirlos
// por todo el conjunto (evita que muchas reseñas seguidas compartan apellido).
function realUserName(index) {
    const idx = Math.max(0, Number(index) - 1) || 0;
    const first = FIRST_NAMES[idx % FIRST_NAMES.length];
    const last = LAST_NAMES[(idx * 13 + 5) % LAST_NAMES.length];
    return `${first} ${last}`;
}

// Engendra el número exacto de usuarios ficticios para respetar la regla
// "una reseña por usuario y obra" sin colisiones (RESEÑA duplicada).
function makeUsers(count) {
    const users = [];
    for (let i = 0; i < count; i++) {
        const n = String(i + 1).padStart(4, "0");
        users.push({
            userId: `seed_user_${n}`,
            userName: realUserName(i + 1)
        });
    }
    return users;
}

// Comprueba que la obra esté en el catálogo (colecciones movies/series),
// así las reseñas se podrán ver en el panel de administración.
async function checkInCatalog(media) {
    try {
        const coll = media.mediaType === "movie" ? "movies" : "series";
        const snap = await db.collection(coll).where("imdbID", "==", media.imdbID).limit(1).get();
        return !snap.empty;
    } catch {
        return null; // no se pudo comprobar
    }
}

async function createReviewsForMedia(media, count, users) {
    const mediaKey = ReviewModel.buildMediaKey({ mediaType: media.mediaType, imdbID: media.imdbID, title: media.title, year: media.year });
    console.log(`\n=== ${media.title} (${media.mediaType}, ${media.imdbID}) mediaKey=${mediaKey} ===`);

    const inCatalog = await checkInCatalog(media);
    if (inCatalog === false) console.warn(`  ⚠️  ATENCIÓN: "${media.title}" NO está en el catálogo (colección ${media.mediaType === "movie" ? "movies" : "series"}). Las reseñas no se verán en el panel admin.`);
    else if (inCatalog === null) console.warn(`  ⚠️  No pude comprobar el catálogo.`);

    const pool = shuffle(REVIEWS);
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < count; i++) {
        const user = users[i % users.length];
        const item = pool[i % pool.length];
        const rating = getRandomRating(item.label);
        const input = {
            mediaType: media.mediaType,
            imdbID: media.imdbID,
            mediaTitle: media.title,
            mediaYear: media.year,
            text: item.text,
            rating
        };

        if (dryRun) {
            console.log(`  [DRY-RUN] iría a crear #${String(i + 1).padStart(3, "0")} usuario=${user.userName} rating=${rating} (${item.label})`);
            created++;
            continue;
        }

        try {
            await ReviewModel.create({ userId: user.userId, userName: user.userName }, input);
            created++;
        } catch (error) {
            if (error && error.code === "REVIEW_DUPLICATE") skipped++;
            else {
                errors++;
                console.error(`  Error en reseña #${i + 1} (${user.userName}): ${error && error.message ? error.message : error}`);
            }
        }
        await sleep(50);
    }

    console.log(`  → ${dryRun ? "Simuladas" : "Creadas"}: ${created} | ${dryRun ? "(sin escribir nada)" : `Duplicadas: ${skipped} | Errores: ${errors}`}`);
    return created;
}

async function main() {
    if (!Number.isInteger(reviewsPerMedia) || reviewsPerMedia < 1 || reviewsPerMedia > 2000) {
        console.error("--count debe ser un entero entre 1 y 2000.");
        process.exit(1);
    }

    console.log(`${dryRun ? "SIMULACIÓN (--dry-run): no se escribirá nada en Firestore." : "EJECUCIÓN REAL"} | ${reviewsPerMedia} reseñas por obra ${MEDIA.length > 1 ? `(${MEDIA.map((m) => m.title).join(" + ")})` : ""}.`);
    const users = makeUsers(reviewsPerMedia);
    const byMedia = [];

    for (const media of MEDIA) {
        byMedia.push(await createReviewsForMedia(media, reviewsPerMedia, users));
        await sleep(100);
    }

    const total = byMedia.reduce((a, b) => a + b, 0);
    console.log(`\nResumen: ${dryRun ? "simuladas" : "creadas"} ${total} reseñas (${byMedia.join(" + ")}) en ${MEDIA.length} obra(s).`);
    if (dryRun) console.log("Ejecuta sin --dry-run para escribirlas de verdad.");
    process.exit(0);
}

module.exports = { MEDIA, REVIEWS, getRandomRating, makeUsers, realUserName };

if (require.main === module) {
    main().catch((error) => {
        console.error("Error general:", error && error.message ? error.message : error);
        process.exit(1);
    });
}