import { describe, expect, it } from 'vitest';
import { parseTranscript } from './transcript';
import {
  collapseRepetitions,
  courseDocument,
  htmlToText,
  lectureDocument,
  readableParagraphs,
  type LectureContext,
} from './llm-text';

// Verbatim Udemy auto-captions, as the caption-per-line export wrote them.
const RAW = `[00:04] Hello.

[00:05] In the previous video you have seen some definition connected to prime numbers divisibility.

[00:12] And I also mentioned a prime factorization.

[00:16] And now you will see a three examples and how to how to find a prime factorization of numbers.

[00:24] And.

[00:25] But before I will start I will tell you why it is important to be able to factor numbers.

[00:33] So there are many reasons for this.

[00:35] The reasons for for algebra and calculus are that when you, for example, add fractions, then you

[00:44] will need a factorization of of your denominators in order to find the least common denominator for

[00:52] two fractions, or maybe more fractions.

[00:55] If you if you have to add more than than two fractions, and then another when you will factor polynomials,

[01:05] for example.

[01:06] It is also important to to be able to factor the constant term in polynomial.

[01:12] You will see why in the second precalculus course, when I when I will discuss polynomials and factorization

[01:22] of polynomials.

[01:23] And there are many, many more reasons for a prime factorization.

[01:28] Factorization.`;

const CUES = parseTranscript(RAW);

describe('collapseRepetitions', () => {
  it('removes stutters of one to four words', () => {
    expect(collapseRepetitions('how to how to find')).toBe('how to find');
    expect(collapseRepetitions('a factorization of of your')).toBe('a factorization of your');
    expect(collapseRepetitions('when I when I will')).toBe('when I will');
  });

  it('removes the repeat a cue boundary leaves behind', () => {
    expect(collapseRepetitions('a prime factorization. Factorization.')).toBe('a prime factorization.');
  });

  it('keeps repetitions that are separated', () => {
    expect(collapseRepetitions('many, many more')).toBe('many, many more');
    expect(collapseRepetitions('the cat and the dog')).toBe('the cat and the dog');
  });

  it('works on accented words', () => {
    expect(collapseRepetitions('une une équation équation')).toBe('une équation');
    expect(collapseRepetitions('égal également')).toBe('égal également');
  });
});

describe('readableParagraphs', () => {
  const paragraphs = readableParagraphs(CUES);
  const text = paragraphs.join('\n\n');

  it('merges caption lines into paragraphs with one timestamp each', () => {
    expect(paragraphs.length).toBeLessThan(4);
    expect(paragraphs[0].startsWith('[00:04] Hello. In the previous video')).toBe(true);
  });

  it('rejoins sentences cut across cues', () => {
    expect(text).toContain('then you will need a factorization of your denominators');
  });

  it('drops stutters and orphaned connectives', () => {
    expect(text).not.toMatch(/how to how to|of of|for for|to to|when I when I|If you if you|than than/i);
    expect(text).not.toContain('And. ');
    expect(text).not.toMatch(/Factorization\.\s*$/);
  });
});

describe('htmlToText', () => {
  it('turns an article into readable paragraphs', () => {
    const html = '<h2>Intro</h2><p>Primes &amp; factors.</p><ul><li>2</li><li>3</li></ul><script>x()</script>';
    expect(htmlToText(html)).toBe('Intro\n\nPrimes & factors.\n\n- 2\n\n- 3');
  });
});

describe('documents', () => {
  const context: LectureContext = {
    courseTitle: 'Precalculus',
    sectionIndex: 2,
    sectionTitle: 'Numbers',
    lectureIndex: 12,
    lectureTitle: 'Prime factorization',
    url: 'https://www.udemy.com/course/pre/learn/lecture/1',
    durationSeconds: 600,
    language: 'English',
    resources: ['primes.pdf'],
  };

  it('heads a lecture with where it sits in the course', () => {
    const doc = lectureDocument(CUES, context);
    expect(doc.startsWith('# 12. Prime factorization\n\nCourse: Precalculus\nSection 2: Numbers · 10 min · Subtitles: English')).toBe(true);
    expect(doc).toContain('Attached resources: primes.pdf');
  });

  it('puts a whole course in one file, with contents, in order', () => {
    const doc = courseDocument('Precalculus', [
      { context, cues: CUES },
      { context: { ...context, lectureIndex: 13, lectureTitle: 'Practice' }, cues: null, note: 'Quiz — online only.' },
    ]);
    expect(doc).toContain('## Contents');
    expect(doc).toContain('## Section 2: Numbers');
    expect(doc.indexOf('### 12. Prime factorization')).toBeLessThan(doc.indexOf('### 13. Practice'));
    expect(doc).toContain('_Quiz — online only._');
  });
});
