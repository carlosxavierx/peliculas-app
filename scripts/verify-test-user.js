// Dev helper: marca el email de un usuario de test como verificado (solo local/dev).
// Uso: node scripts/verify-test-user.js <email>
const admin = require("firebase-admin");
const { getAuth } = require("firebase-admin/auth");
const path = require("path");

const email = process.argv[2];
if (!email) {
    console.error("Uso: node scripts/verify-test-user.js <email>");
    process.exit(1);
}

async function main() {
    const keyPath = path.join(__dirname, "..", "firebase-key.json");
    const serviceAccount = require(keyPath);

    admin.initializeApp({
        credential: typeof admin.cert === "function"
            ? admin.cert(serviceAccount)
            : admin.credential.cert(serviceAccount)
    });

    const auth = getAuth();
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { emailVerified: true });
    console.log("OK: email verificado para " + email);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Error:", err.message);
        process.exit(1);
    });