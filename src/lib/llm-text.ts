/**
 * Transcripts written to be read by a language model.
 *
 * A caption file is the wrong shape for a model. A cue is two seconds of
 * speech, so sentences are cut mid-clause across lines, every line spends
 * tokens on a timestamp, and the speaker's stutters ("how to how to", "of of")
 * and orphaned connectives ("And.") are kept verbatim. Instruction-tuned
 * models read verbatim disfluency measurably worse, and a transcript with no
 * title says nothing about where in the course it sits.
 *
 * So the text here is: cleaned by the shared pipeline (fillers, sound tags,
 * technical terms), stripped of immediate repetitions, merged into paragraphs
 * with one timestamp each — enough to cite back into the video, cheap enough
 * not to matter — and headed with the course, section and lecture it belongs
 * to.
 *
 * Pure functions; the caption files come in as parsed cues.
 */

import { cleanCues, formatTimestamp, groupIntoParagraphs, type Cue } from './transcript';

/** Connectives that, alone in a cue, are a false start rather than a sentence. */
const ORPHAN = /^(and|so|but|or|okay|ok|well|now|right|yeah|alright|all right)[.,!?]?$/i;

/**
 * Collapse words or short phrases said twice in a row.
 *
 * "how to how to find" → "how to find", "of of" → "of", and the
 * "factorization. Factorization." a cue boundary leaves behind. Up to four
 * words, case-insensitive, back to back or across a full stop. Run until
 * stable, because "I when I when I will" needs two passes.
 *
 * A comma between the two is left alone: "many, many more" is emphasis, not a
 * stutter. The rare deliberate back-to-back repetition ("had had") goes; for
 * reading by a model that is the right trade.
 */
export function collapseRepetitions(text: string): string {
  // Lookarounds, not `\b`: JavaScript's `\b` is ASCII-only, so it would cut
  // "répété" in the middle of a word.
  const repeated =
    /(?<![\p{L}\p{N}'])([\p{L}\p{N}']+(?:\s+[\p{L}\p{N}']+){0,3})\.?\s+\1(?![\p{L}\p{N}'])/giu;
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(repeated, '$1');
  } while (current !== previous);
  return current;
}

/** Drop false starts, then the stutters across what used to be cue boundaries. */
export function prepareCues(cues: Cue[]): Cue[] {
  return cleanCues(cues)
    .filter((cue) => !ORPHAN.test(cue.text.trim()))
    .map((cue) => ({ ...cue, text: collapseRepetitions(cue.text) }));
}

/**
 * The transcript as paragraphs, one timestamp each.
 *
 * Repetitions are collapsed again after merging: the paragraph is where a
 * phrase ending one cue meets its repeat starting the next.
 */
export function readableParagraphs(cues: Cue[], minWords = 90): string[] {
  return groupIntoParagraphs(prepareCues(cues), minWords).map((paragraph) => {
    const text = collapseRepetitions(paragraph.text).replace(/\s+([.,!?])/g, '$1');
    return paragraph.startSeconds === null ? text : `[${formatTimestamp(paragraph.startSeconds)}] ${text}`;
  });
}

export interface LectureContext {
  courseTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  lectureIndex: number;
  lectureTitle: string;
  url?: string;
  durationSeconds?: number;
  /** Language label of the subtitles the text comes from. */
  language?: string;
  /** Names of the files attached to the lecture, so a model knows they exist. */
  resources?: string[];
}

function minutes(seconds: number | undefined): string | null {
  if (!seconds) return null;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function contextLines(context: LectureContext): string[] {
  const details = [
    `Section ${context.sectionIndex}: ${context.sectionTitle}`,
    minutes(context.durationSeconds),
    context.language ? `Subtitles: ${context.language}` : null,
  ].filter(Boolean);
  const lines = [details.join(' · ')];
  if (context.url) lines.push(`Source: ${context.url}`);
  if (context.resources && context.resources.length > 0) {
    lines.push(`Attached resources: ${context.resources.join(', ')}`);
  }
  return lines;
}

/** One lecture as a self-contained document. */
export function lectureDocument(cues: Cue[], context: LectureContext): string {
  return [
    `# ${context.lectureIndex}. ${context.lectureTitle}`,
    '',
    `Course: ${context.courseTitle}`,
    ...contextLines(context),
    '',
    ...readableParagraphs(cues).flatMap((paragraph) => [paragraph, '']),
  ].join('\n');
}

/**
 * An article lecture's HTML as plain paragraphs.
 *
 * Regex rather than a DOM parser so it runs anywhere, the tests included. It
 * only has to be readable, not faithful: block ends become paragraph breaks,
 * list items keep a dash, everything else loses its markup.
 */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|pre|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (match, name: string) =>
      name.startsWith('#')
        ? String.fromCodePoint(Number(name.slice(1)) || 32)
        : (entities[name] ?? match),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface CourseDocumentLecture {
  context: LectureContext;
  /** Null when the lecture has no usable subtitles: it is still listed. */
  cues: Cue[] | null;
  /** Text of an article lecture, used when there are no cues. */
  text?: string;
  /** Why the lecture has no text — a quiz, an article, no subtitles. */
  note?: string;
}

/**
 * The whole course as one document, in course order.
 *
 * One file is what a model is best given: the order of lectures carries the
 * course's argument, and a contents list up front lets it answer "which
 * lecture covers…" without reading everything twice.
 */
export function courseDocument(
  courseTitle: string,
  lectures: CourseDocumentLecture[],
  source?: string,
): string {
  const lines = [`# ${courseTitle}`, ''];
  if (source) lines.push(`Source: ${source}`, '');

  lines.push('## Contents', '');
  let section = -1;
  for (const { context } of lectures) {
    if (context.sectionIndex !== section) {
      section = context.sectionIndex;
      lines.push(`- Section ${context.sectionIndex}: ${context.sectionTitle}`);
    }
    lines.push(`  - ${context.lectureIndex}. ${context.lectureTitle}`);
  }
  lines.push('');

  section = -1;
  for (const { context, cues, text, note } of lectures) {
    if (context.sectionIndex !== section) {
      section = context.sectionIndex;
      lines.push(`## Section ${context.sectionIndex}: ${context.sectionTitle}`, '');
    }
    lines.push(`### ${context.lectureIndex}. ${context.lectureTitle}`, '');
    const meta = [minutes(context.durationSeconds), context.url].filter(Boolean).join(' · ');
    if (meta) lines.push(meta);
    if (context.resources && context.resources.length > 0) {
      lines.push(`Attached resources: ${context.resources.join(', ')}`);
    }
    if (meta || context.resources?.length) lines.push('');

    const paragraphs = cues ? readableParagraphs(cues) : [];
    if (paragraphs.length > 0) {
      for (const paragraph of paragraphs) lines.push(paragraph, '');
    } else if (text) {
      lines.push(text, '');
    } else {
      lines.push(`_${note ?? 'No transcript for this lecture.'}_`, '');
    }
  }

  return lines.join('\n');
}
