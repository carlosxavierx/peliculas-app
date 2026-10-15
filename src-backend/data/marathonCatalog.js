// Catálogo curado de maratones.
//
// Cada maratón es una lista ORDENADA de obras. El orden es el de visionado
// obligatorio: no se desbloquea la 2ª hasta marcar la 1ª como vista.
//   - Sagas: orden argumental (el de estreno de la saga).
//   - Actores/actrices: de la película MÁS ANTIGUA a la MÁS RECIENTE.
//
// `imdbID` es la fuente de verdad; `title` y `year` sirven de verificación y
// como respaldo si el id falla (el script cae a la búsqueda por título+año).
// Este fichero es sólo datos: no requiere red ni Firestore.

const MARATHON_CATALOG = [
    // ---------------- Sagas ----------------
    {
        id: "saga-senor-de-los-anillos",
        title: "El Señor de los Anillos",
        kind: "saga",
        order: 1,
        description: "La trilogía de la Tierra Media en orden argumental, de la Comarca al Monte del Destino.",
        items: [
            { title: "The Lord of the Rings: The Fellowship of the Ring", year: "2001", imdbID: "tt0120737" },
            { title: "The Lord of the Rings: The Two Towers", year: "2002", imdbID: "tt0167261" },
            { title: "The Lord of the Rings: The Return of the King", year: "2003", imdbID: "tt0167260" }
        ]
    },
    {
        id: "saga-harry-potter",
        title: "Harry Potter",
        kind: "saga",
        order: 2,
        description: "Las ocho películas del niño que sobrevivió, curso a curso hasta la batalla final.",
        items: [
            { title: "Harry Potter and the Sorcerer's Stone", year: "2001", imdbID: "tt0241527" },
            { title: "Harry Potter and the Chamber of Secrets", year: "2002", imdbID: "tt0295297" },
            { title: "Harry Potter and the Prisoner of Azkaban", year: "2004", imdbID: "tt0304141" },
            { title: "Harry Potter and the Goblet of Fire", year: "2005", imdbID: "tt0330373" },
            { title: "Harry Potter and the Order of the Phoenix", year: "2007", imdbID: "tt0373889" },
            { title: "Harry Potter and the Half-Blood Prince", year: "2009", imdbID: "tt0417741" },
            { title: "Harry Potter and the Deathly Hallows: Part 1", year: "2010", imdbID: "tt0926084" },
            { title: "Harry Potter and the Deathly Hallows: Part 2", year: "2011", imdbID: "tt1201607" }
        ]
    },
    {
        id: "saga-star-wars",
        title: "Star Wars (trilogía original)",
        kind: "saga",
        order: 3,
        description: "Episodios IV, V y VI: la trilogía original, tal y como se estrenó.",
        items: [
            { title: "Star Wars: Episode IV - A New Hope", year: "1977", imdbID: "tt0076759" },
            { title: "Star Wars: Episode V - The Empire Strikes Back", year: "1980", imdbID: "tt0080684" },
            { title: "Star Wars: Episode VI - Return of the Jedi", year: "1983", imdbID: "tt0086190" }
        ]
    },
    {
        id: "saga-el-padrino",
        title: "El Padrino",
        kind: "saga",
        order: 4,
        description: "La saga de la familia Corleone, de Vito a Michael. Obra maestra del cine de gánsteres.",
        items: [
            { title: "The Godfather", year: "1972", imdbID: "tt0068646" },
            { title: "The Godfather Part II", year: "1974", imdbID: "tt0071562" },
            { title: "The Godfather Part III", year: "1990", imdbID: "tt0099674" }
        ]
    },
    {
        id: "saga-matrix",
        title: "Matrix",
        kind: "saga",
        order: 5,
        description: "La trilogía de las hermanas Wachowski: de la pastilla roja al último combate.",
        items: [
            { title: "The Matrix", year: "1999", imdbID: "tt0133093" },
            { title: "The Matrix Reloaded", year: "2003", imdbID: "tt0234215" },
            { title: "The Matrix Revolutions", year: "2003", imdbID: "tt0242653" }
        ]
    },
    {
        id: "saga-indiana-jones",
        title: "Indiana Jones",
        kind: "saga",
        order: 6,
        description: "El arqueólogo más famoso del cine, látigo en mano, en orden de estreno.",
        items: [
            { title: "Raiders of the Lost Ark", year: "1981", imdbID: "tt0082971" },
            { title: "Indiana Jones and the Temple of Doom", year: "1984", imdbID: "tt0087469" },
            { title: "Indiana Jones and the Last Crusade", year: "1989", imdbID: "tt0097576" },
            { title: "Indiana Jones and the Kingdom of the Crystal Skull", year: "2008", imdbID: "tt0367882" }
        ]
    },

    // ---------------- Actores y actrices ----------------
    // Siempre de la más antigua a la más reciente.
    {
        id: "actor-leonardo-dicaprio",
        title: "Leonardo DiCaprio",
        kind: "actor",
        order: 7,
        description: "De niño prodigio a estrella total: la filmografía clave de DiCaprio en orden cronológico.",
        items: [
            { title: "What's Eating Gilbert Grape", year: "1993", imdbID: "tt0108550" },
            { title: "Titanic", year: "1997", imdbID: "tt0120338" },
            { title: "Catch Me If You Can", year: "2002", imdbID: "tt0264464" },
            { title: "The Aviator", year: "2004", imdbID: "tt0338751" },
            { title: "The Departed", year: "2006", imdbID: "tt0407887" },
            { title: "Inception", year: "2010", imdbID: "tt1375666" },
            { title: "The Wolf of Wall Street", year: "2013", imdbID: "tt0993846" },
            { title: "The Revenant", year: "2015", imdbID: "tt1663202" },
            { title: "Once Upon a Time... in Hollywood", year: "2019", imdbID: "tt7131622" }
        ]
    },
    {
        id: "actor-tom-hanks",
        title: "Tom Hanks",
        kind: "actor",
        order: 8,
        description: "El actor corriente favorito de América, de la comedia de los 80 al drama de los 2000.",
        items: [
            { title: "Big", year: "1988", imdbID: "tt0094737" },
            { title: "Forrest Gump", year: "1994", imdbID: "tt0109830" },
            { title: "Apollo 13", year: "1995", imdbID: "tt0112384" },
            { title: "Saving Private Ryan", year: "1998", imdbID: "tt0120815" },
            { title: "The Green Mile", year: "1999", imdbID: "tt0120689" },
            { title: "Cast Away", year: "2000", imdbID: "tt0162222" },
            { title: "Bridge of Spies", year: "2015", imdbID: "tt3682448" },
            { title: "A Beautiful Day in the Neighborhood", year: "2019", imdbID: "tt3224458" }
        ]
    },
    {
        id: "actor-meryl-streep",
        title: "Meryl Streep",
        kind: "actor",
        order: 9,
        description: "La actriz con más nominaciones de la historia, de sus primeros dramas a sus comedias más afiladas.",
        items: [
            { title: "Kramer vs. Kramer", year: "1979", imdbID: "tt0079417" },
            { title: "Sophie's Choice", year: "1982", imdbID: "tt0084707" },
            { title: "Out of Africa", year: "1985", imdbID: "tt0089755" },
            { title: "The Bridges of Madison County", year: "1995", imdbID: "tt0112579" },
            { title: "Adaptation.", year: "2002", imdbID: "tt0268126" },
            { title: "The Devil Wears Prada", year: "2006", imdbID: "tt0458352" },
            { title: "Julie & Julia", year: "2009", imdbID: "tt1135503" },
            { title: "The Iron Lady", year: "2011", imdbID: "tt1007029" },
            { title: "The Post", year: "2017", imdbID: "tt6294822" }
        ]
    },
    {
        id: "actor-al-pacino",
        title: "Al Pacino",
        kind: "actor",
        order: 10,
        description: "Del policía infiltrado al gánster inmortal: el recorrido esencial de Pacino.",
        items: [
            { title: "Serpico", year: "1973", imdbID: "tt0070666" },
            { title: "Dog Day Afternoon", year: "1975", imdbID: "tt0072890" },
            { title: "Scarface", year: "1983", imdbID: "tt0086250" },
            { title: "Scent of a Woman", year: "1992", imdbID: "tt0105323" },
            { title: "Heat", year: "1995", imdbID: "tt0113277" },
            { title: "Donnie Brasco", year: "1997", imdbID: "tt0119008" },
            { title: "The Irishman", year: "2019", imdbID: "tt1302006" }
        ]
    },
    {
        id: "actor-nicole-kidman",
        title: "Nicole Kidman",
        kind: "actor",
        order: 11,
        description: "Del thriller australiano de los 80 a los grandes dramas y biopics de la última década.",
        items: [
            { title: "Dead Calm", year: "1989", imdbID: "tt0097162" },
            { title: "To Die For", year: "1995", imdbID: "tt0114681" },
            { title: "Moulin Rouge!", year: "2001", imdbID: "tt0203009" },
            { title: "The Others", year: "2001", imdbID: "tt0230600" },
            { title: "The Hours", year: "2002", imdbID: "tt0274558" },
            { title: "Cold Mountain", year: "2003", imdbID: "tt0159365" },
            { title: "Lion", year: "2016", imdbID: "tt3741834" },
            { title: "Bombshell", year: "2019", imdbID: "tt6394270" }
        ]
    },
    {
        id: "actor-brad-pitt",
        title: "Brad Pitt",
        kind: "actor",
        order: 12,
        description: "Del chico guapo de los 90 al actor de carácter premiado: filmografía clave en orden cronológico.",
        items: [
            { title: "Thelma & Louise", year: "1991", imdbID: "tt0103074" },
            { title: "A River Runs Through It", year: "1992", imdbID: "tt0105265" },
            // OMDb guarda estas dos con otro título ("Seven", "12 Monkeys"):
            // usamos el suyo para que la ficha y el maratón coincidan siempre.
            { title: "Seven", year: "1995", imdbID: "tt0114369" },
            { title: "12 Monkeys", year: "1996", imdbID: "tt0114746" },
            { title: "Fight Club", year: "1999", imdbID: "tt0137523" },
            { title: "Ocean's Eleven", year: "2001", imdbID: "tt0240772" },
            { title: "Troy", year: "2004", imdbID: "tt0332452" },
            { title: "Moneyball", year: "2011", imdbID: "tt1210166" },
            { title: "Babylon", year: "2022", imdbID: "tt10640346" }
        ]
    }
];

module.exports = { MARATHON_CATALOG };
