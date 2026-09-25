/**
 * Built-in questions: used when the selected packs cannot fill a game (a server without the
 * `trivia-mc` packs, a client scenario with no content, or a long session that has used up the
 * packs). 48 original, evergreen questions: 6 per launch category, 2 per difficulty. Each one
 * satisfies the `trivia-mc` schema and the question-writing rules (≤ 110 / ≤ 28 characters, one
 * defensible answer, no "which is NOT"); `test/logic.test.ts` validates them with the schema.
 *
 * @module
 */
import type { McItem } from "./types.ts";

type Row = [
  id: string,
  category: string,
  difficulty: 1 | 2 | 3,
  q: string,
  options: [string, string, string, string],
  correct: 0 | 1 | 2 | 3,
  wiki: string,
];

// prettier-ignore
const ROWS: readonly Row[] = [
  // General
  ["fb-gen-1", "General", 1, "How many days are in a leap year?", ["365", "366", "364", "360"], 1, "Leap_year"],
  ["fb-gen-2", "General", 1, "Mix blue and yellow paint together and you get which colour?", ["Green", "Purple", "Orange", "Brown"], 0, "Secondary_color"],
  ["fb-gen-3", "General", 2, "How many sides does a hexagon have?", ["Five", "Six", "Seven", "Eight"], 1, "Hexagon"],
  ["fb-gen-4", "General", 2, "A standard deck without its jokers holds how many cards?", ["48", "50", "52", "54"], 2, "Standard_52-card_deck"],
  ["fb-gen-5", "General", 3, "How many squares are on a chessboard?", ["36", "49", "64", "81"], 2, "Chessboard"],
  ["fb-gen-6", "General", 3, "In Roman numerals, which letter stands for 500?", ["C", "D", "L", "M"], 1, "Roman_numerals"],
  // Geography
  ["fb-geo-1", "Geography", 1, "Which is the largest ocean on Earth?", ["Atlantic", "Indian", "Pacific", "Arctic"], 2, "Pacific_Ocean"],
  ["fb-geo-2", "Geography", 1, "What is the capital city of France?", ["Lyon", "Paris", "Marseille", "Nice"], 1, "Paris"],
  ["fb-geo-3", "Geography", 2, "Which river flows through the city of Cairo?", ["Nile", "Congo", "Niger", "Zambezi"], 0, "Nile"],
  ["fb-geo-4", "Geography", 2, "Mount Kilimanjaro rises in which country?", ["Kenya", "Tanzania", "Uganda", "Ethiopia"], 1, "Mount_Kilimanjaro"],
  ["fb-geo-5", "Geography", 3, "What is the capital city of Canada?", ["Toronto", "Vancouver", "Ottawa", "Montreal"], 2, "Ottawa"],
  ["fb-geo-6", "Geography", 3, "The city of Marrakesh is in which country?", ["Morocco", "Tunisia", "Egypt", "Algeria"], 0, "Marrakesh"],
  // Science
  ["fb-sci-1", "Science", 1, "Which planet is nicknamed the Red Planet?", ["Venus", "Mars", "Jupiter", "Mercury"], 1, "Mars"],
  ["fb-sci-2", "Science", 1, "Which gas do plants take in from the air to make their food?", ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"], 2, "Photosynthesis"],
  ["fb-sci-3", "Science", 2, "What is the chemical symbol for gold?", ["Go", "Gd", "Au", "Ag"], 2, "Gold"],
  ["fb-sci-4", "Science", 2, "How many bones are in a typical adult human skeleton?", ["186", "206", "226", "246"], 1, "Human_skeleton"],
  ["fb-sci-5", "Science", 3, "Which planet races around the Sun in the shortest year?", ["Mercury", "Venus", "Mars", "Earth"], 0, "Mercury_(planet)"],
  ["fb-sci-6", "Science", 3, "In an animal cell, which part holds most of the DNA?", ["Nucleus", "Ribosome", "Membrane", "Vacuole"], 0, "Cell_nucleus"],
  // History
  ["fb-his-1", "History", 1, "Which ancient people built the great pyramids of Giza?", ["Romans", "Egyptians", "Greeks", "Aztecs"], 1, "Giza_pyramid_complex"],
  ["fb-his-2", "History", 1, "In which year did people first walk on the Moon?", ["1965", "1969", "1972", "1975"], 1, "Apollo_11"],
  ["fb-his-3", "History", 2, "Who was the first person to travel into space?", ["Yuri Gagarin", "Neil Armstrong", "John Glenn", "Alan Shepard"], 0, "Yuri_Gagarin"],
  ["fb-his-4", "History", 2, "In which year did the Berlin Wall fall?", ["1985", "1989", "1991", "1993"], 1, "Fall_of_the_Berlin_Wall"],
  ["fb-his-5", "History", 3, "Which empire built the mountain city of Machu Picchu?", ["Maya", "Aztec", "Inca", "Olmec"], 2, "Machu_Picchu"],
  ["fb-his-6", "History", 3, "In which century was the Magna Carta first sealed?", ["11th", "13th", "15th", "17th"], 1, "Magna_Carta"],
  // Movies & TV
  ["fb-mtv-1", "Movies & TV", 1, "In the 1939 film of The Wizard of Oz, what colour is the brick road?", ["Yellow", "Red", "Green", "Blue"], 0, "The_Wizard_of_Oz_(1939_film)"],
  ["fb-mtv-2", "Movies & TV", 1, "What kind of animal is Simba in The Lion King?", ["Tiger", "Lion", "Cheetah", "Leopard"], 1, "The_Lion_King"],
  ["fb-mtv-3", "Movies & TV", 2, "Which film has a giant shark menacing the beaches of Amity Island?", ["Jaws", "Deep Blue Sea", "The Meg", "Orca"], 0, "Jaws_(film)"],
  ["fb-mtv-4", "Movies & TV", 2, "In Toy Story, what is the name of the cowboy doll?", ["Buzz", "Woody", "Jessie", "Rex"], 1, "Toy_Story"],
  ["fb-mtv-5", "Movies & TV", 3, "Who directed the 1993 film Jurassic Park?", ["James Cameron", "Steven Spielberg", "George Lucas", "Ridley Scott"], 1, "Jurassic_Park_(film)"],
  ["fb-mtv-6", "Movies & TV", 3, "Stranger Things is set in which fictional Indiana town?", ["Hawkins", "Derry", "Riverdale", "Twin Peaks"], 0, "Stranger_Things"],
  // Music
  ["fb-mus-1", "Music", 1, "How many strings does a standard guitar have?", ["Four", "Five", "Six", "Seven"], 2, "Guitar"],
  ["fb-mus-2", "Music", 1, "Which instrument has 88 keys on a standard full-size model?", ["Piano", "Organ", "Accordion", "Harp"], 0, "Piano"],
  ["fb-mus-3", "Music", 2, "Which band released the album Abbey Road?", ["The Beatles", "The Rolling Stones", "Queen", "The Who"], 0, "Abbey_Road"],
  ["fb-mus-4", "Music", 2, "Freddie Mercury was the lead singer of which band?", ["Queen", "Genesis", "Kiss", "Journey"], 0, "Freddie_Mercury"],
  ["fb-mus-5", "Music", 3, "Who composed the piano piece nicknamed the Moonlight Sonata?", ["Mozart", "Bach", "Beethoven", "Chopin"], 2, "Piano_Sonata_No._14_(Beethoven)"],
  ["fb-mus-6", "Music", 3, "How many lines make up a standard music staff?", ["Four", "Five", "Six", "Seven"], 1, "Staff_(music)"],
  // Gaming
  ["fb-gam-1", "Gaming", 1, "What is the name of Nintendo's famous jumping plumber?", ["Luigi", "Mario", "Wario", "Toad"], 1, "Mario"],
  ["fb-gam-2", "Gaming", 1, "In Tetris, what are the four-block falling pieces called?", ["Tetrominoes", "Blocklets", "Pixels", "Quads"], 0, "Tetromino"],
  ["fb-gam-3", "Gaming", 2, "What colour is Sonic the Hedgehog?", ["Red", "Green", "Blue", "Yellow"], 2, "Sonic_the_Hedgehog_(character)"],
  ["fb-gam-4", "Gaming", 2, "In Minecraft, which hissing mob explodes when it gets close?", ["Zombie", "Creeper", "Skeleton", "Enderman"], 1, "Creeper_(Minecraft)"],
  ["fb-gam-5", "Gaming", 3, "Tetris was first created in which country?", ["Japan", "USA", "Soviet Union", "Finland"], 2, "Tetris"],
  ["fb-gam-6", "Gaming", 3, "In The Legend of Zelda series, what is the hero's name?", ["Zelda", "Link", "Ganon", "Epona"], 1, "Link_(The_Legend_of_Zelda)"],
  // Food & Nature
  ["fb-fnn-1", "Food & Nature", 1, "What is the main ingredient of guacamole?", ["Avocado", "Tomato", "Pea", "Lime"], 0, "Guacamole"],
  ["fb-fnn-2", "Food & Nature", 1, "What do honeybees make from flower nectar?", ["Wax", "Honey", "Jam", "Syrup"], 1, "Honey"],
  ["fb-fnn-3", "Food & Nature", 2, "Which is the tallest animal living on land?", ["Elephant", "Giraffe", "Camel", "Moose"], 1, "Giraffe"],
  ["fb-fnn-4", "Food & Nature", 2, "Sushi rice is traditionally seasoned with which vinegar?", ["Rice vinegar", "Malt vinegar", "Cider vinegar", "Balsamic"], 0, "Sushi"],
  ["fb-fnn-5", "Food & Nature", 3, "Marzipan is made mostly from which nut?", ["Walnut", "Almond", "Cashew", "Hazelnut"], 1, "Marzipan"],
  ["fb-fnn-6", "Food & Nature", 3, "How many hearts does an octopus have?", ["One", "Two", "Three", "Four"], 2, "Octopus"],
];

/** The built-in questions (schema-valid `trivia-mc` items). */
export const FALLBACK_QUESTIONS: readonly McItem[] = Object.freeze(
  ROWS.map(([id, category, difficulty, q, options, correct, wiki]) =>
    Object.freeze({
      id,
      q,
      options,
      correct,
      category,
      difficulty,
      source: `https://en.wikipedia.org/wiki/${wiki}`,
    }),
  ),
);
