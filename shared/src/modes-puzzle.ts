/**
 * The puzzle that opens the modes' secrets in Developer options: one question
 * in the style of an intelligence test (a series, an analogy, the odd one out,
 * a bit of logic), four answers, one right. Solved, the paths, their progress
 * and the words show until Developer options are switched off.
 *
 * None of the questions or answers may hold a mode's word.
 */
export interface ModePuzzle {
  id: string;
  question: string;
  options: string[];
  /** Index of the right option. */
  answer: number;
}

/** What the browser is shown: the question and its options, never the answer. */
export type ModePuzzleQuestion = Omit<ModePuzzle, 'answer'>;

export const MODE_PUZZLES: ModePuzzle[] = [
  { id: 'double', question: 'What comes next: 3, 6, 12, 24, ...', options: ['36', '42', '48', '30'], answer: 2 },
  { id: 'squares', question: 'What comes next: 1, 4, 9, 16, 25, ...', options: ['30', '36', '35', '49'], answer: 1 },
  { id: 'fib', question: 'What comes next: 1, 1, 2, 3, 5, 8, ...', options: ['11', '12', '13', '16'], answer: 2 },
  { id: 'gaps', question: 'What comes next: 2, 3, 5, 8, 12, 17, ...', options: ['21', '22', '23', '24'], answer: 2 },
  { id: 'letters', question: 'What comes next: A, C, F, J, ...', options: ['M', 'N', 'O', 'P'], answer: 2 },
  { id: 'back', question: 'What comes next: Z, X, V, T, ...', options: ['S', 'R', 'Q', 'P'], answer: 1 },
  { id: 'triple', question: 'What comes next: 2, 6, 18, 54, ...', options: ['108', '72', '162', '148'], answer: 2 },
  { id: 'alternate', question: 'What comes next: 1, 10, 2, 20, 3, 30, ...', options: ['4', '40', '31', '33'], answer: 0 },
  { id: 'glove', question: 'Glove is to hand as sock is to ...', options: ['shoe', 'foot', 'leg', 'knee'], answer: 1 },
  { id: 'author', question: 'Book is to author as song is to ...', options: ['singer', 'composer', 'radio', 'album'], answer: 1 },
  { id: 'kitten', question: 'Puppy is to dog as kitten is to ...', options: ['mouse', 'cat', 'lion', 'tiger'], answer: 1 },
  { id: 'odd-number', question: 'Which one does not belong: 3, 5, 9, 11, 13', options: ['3', '9', '11', '13'], answer: 1 },
  { id: 'odd-shape', question: 'Which one does not belong: circle, square, cube, triangle', options: ['circle', 'square', 'cube', 'triangle'], answer: 2 },
  { id: 'odd-word', question: 'Which one does not belong: oak, pine, maple, rose', options: ['oak', 'pine', 'maple', 'rose'], answer: 3 },
  { id: 'logic', question: 'All wizzles are pims, and all pims are glorks. So all wizzles are...', options: ['glorks', 'not pims', 'never glorks', 'impossible to say'], answer: 0 },
  { id: 'months', question: 'How many months have 28 days?', options: ['1', '2', '6', '12'], answer: 3 },
  { id: 'brothers', question: 'Alex has three sisters, and each sister has one brother. How many brothers are there?', options: ['1', '2', '3', '4'], answer: 0 },
  { id: 'clock', question: 'A clock shows 3:00. What is the angle between its hands?', options: ['45°', '60°', '90°', '120°'], answer: 2 },
  { id: 'mirror', question: 'Which is the mirror image of the word SAM?', options: ['MAS', 'ƧAM', 'MAƧ', 'SAW'], answer: 2 },
  { id: 'half', question: 'If half of 10 is 5, what is half of 2 plus 2?', options: ['2', '3', '4', '1'], answer: 1 },
];

/** A question picked at random, never the one just asked. */
export function nextPuzzle(after?: string, random: () => number = Math.random): ModePuzzle {
  const pool = MODE_PUZZLES.filter((p) => p.id !== after);
  return pool[Math.floor(random() * pool.length)] ?? (MODE_PUZZLES[0] as ModePuzzle);
}

export function puzzleQuestion(p: ModePuzzle): ModePuzzleQuestion {
  return { id: p.id, question: p.question, options: p.options };
}
