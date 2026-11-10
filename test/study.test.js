import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStudyOpenRouterRequest,
  parseStudyQuiz,
  parseStudyQuizWithRetry,
  prepareStudyGuideWithRetry,
  renderStudyQuiz,
  StudyFileError,
  StudyQuizError,
} from '../study.js';

function createValidExam() {
  return JSON.stringify({
    title: 'AI Essentials Mock Exam',
    questions: Array.from({ length: 5 }, (_, index) => ({
      topic: index === 0 ? 'Machine learning' : `Topic ${index + 1}`,
      question: `Question ${index + 1}?`,
      choices: ['First choice', 'Second choice', 'Third choice', 'Fourth choice'],
      correctIndex: index % 4,
      explanation: `Explanation ${index + 1}.`,
    })),
  });
}

const request = {
  questionCount: 5,
  systemPrompt: 'Create a five-question exam.',
  userContent: 'Study material',
  responseFormat: { type: 'json_schema' },
};

const completeGuide = `# Database Fundamentals

## Overview

An overview.

## Intended Audience and Prerequisites

Students with basic computer skills.

## Learning Objectives

- Explain a database.

## Study Guide

Databases organize information.

## Worked Examples and Practice

Review a simple table.

## Common Misconceptions

A database is not merely a spreadsheet.

## Review Summary

Databases store and retrieve structured information.

## Key Terms

- Table: A collection of rows.

## Self-Test Questions

1. What is a table?

## Answer Key

1. A collection of related rows.

## Sources

- [Oracle Database documentation](https://docs.oracle.com/en/database/)`;

test('a valid study guide does not use the repair request', async () => {
  let retries = 0;
  const markdown = await prepareStudyGuideWithRetry(completeGuide, {
    systemPrompt: 'Create a guide.', userContent: 'Databases',
  }, async () => {
    retries += 1;
    return completeGuide;
  });
  assert.equal(retries, 0);
  assert.match(markdown, /^# Database Fundamentals/);
});

test('an invalid study guide is repaired once with validation issues and memory writes disabled', async () => {
  let retryRequest;
  const startedAt = Date.now();
  const markdown = await prepareStudyGuideWithRetry('# Incomplete guide', {
    systemPrompt: 'Create a guide.',
    userContent: 'Databases',
    tools: [{ type: 'openrouter:web_search' }],
    appTools: { remember: {} },
  }, async (value) => {
    retryRequest = value;
    return completeGuide;
  });
  assert.match(markdown, /## Sources/);
  assert.equal(retryRequest.appTools, undefined);
  assert.deepEqual(retryRequest.reasoning, { enabled: false });
  assert.ok(retryRequest.deadline >= startedAt + 119_000);
  assert.deepEqual(retryRequest.tools, [{ type: 'openrouter:web_search' }]);
  assert.equal(retryRequest.userContent, 'Databases');
  assert.match(retryRequest.systemPrompt, /missing its learning objectives section/);
  assert.match(retryRequest.systemPrompt, /Memory tools are disabled/);
});

test('a study guide that fails repair returns a safe final error', async () => {
  await assert.rejects(
    prepareStudyGuideWithRetry('# Incomplete guide', {
      systemPrompt: 'Create a guide.', userContent: 'Databases',
    }, async () => '# Still incomplete'),
    (error) => error instanceof StudyFileError && /after one repair attempt/.test(error.userMessage),
  );
});

test('a valid five-question exam renders as the first interactive quiz question', async () => {
  let retryCalls = 0;
  const parsedQuiz = await parseStudyQuizWithRetry(
    createValidExam(),
    request,
    async () => {
      retryCalls += 1;
      throw new Error('A valid exam should not be regenerated.');
    },
  );

  const response = renderStudyQuiz({
    id: '00000000-0000-0000-0000-000000000000',
    ...parsedQuiz,
    answers: new Array(parsedQuiz.questions.length).fill(null),
    questionIndex: 0,
    status: 'answering',
  });

  assert.equal(retryCalls, 0);
  assert.equal(parsedQuiz.questions.length, 5);
  assert.match(response.content, /🎯 \*\*Question 1\/5\*\* · \*Machine learning\*/);
  assert.match(response.content, /\*\*Question 1\?\*\*/);
  assert.match(response.content, /Question 1\/5/);
  assert.equal(response.components[0].components.length, 4);
  assert.deepEqual(
    response.components[0].components.map((button) => button.label),
    ['A. First choice', 'B. Second choice', 'C. Third choice', 'D. Fourth choice'],
  );
});

test('answer feedback shows the result, correct choice, and explanation', () => {
  const parsedQuiz = parseStudyQuiz(createValidExam());
  const quiz = {
    id: '00000000-0000-0000-0000-000000000000',
    ...parsedQuiz,
    answers: [1, null, null, null, null],
    questionIndex: 0,
    status: 'feedback',
  };

  const response = renderStudyQuiz(quiz);

  assert.match(response.content, /🎯 \*\*Question 1\/5\*\* · \*Machine learning\*/);
  assert.match(response.content, /❌ Better luck next time!/);
  assert.match(response.content, /\*\*Correct answer:\*\*/);
  assert.match(response.content, /\*\*A\. First choice\*\*/);
  assert.match(response.content, /\*\*Why:\*\* Explanation 1\./);
  assert.doesNotMatch(response.content, /Your answer:|✅|▫️/);
  assert.equal(response.components[0].components.length, 1);
});

test('missed-answer review labels and bolds the correct choice without result emoji', () => {
  const parsedQuiz = parseStudyQuiz(createValidExam());
  const quiz = {
    id: '00000000-0000-0000-0000-000000000000',
    ...parsedQuiz,
    answers: [1, null, null, null, null],
    questionIndex: 0,
    status: 'review',
    reviewIndexes: [0],
    reviewIndex: 0,
  };

  const response = renderStudyQuiz(quiz);

  assert.match(response.content, /\*\*Correct answer:\*\*/);
  assert.match(response.content, /\*\*A\. First choice\*\*/);
  assert.match(response.content, /\*\*Why:\*\* Explanation 1\./);
  assert.doesNotMatch(response.content, /Your answer:/);
  assert.doesNotMatch(response.content, /✅|❌|▫️/);
});

test('answer choices with repeated option labels render with one letter each', () => {
  const exam = JSON.parse(createValidExam());
  exam.questions = exam.questions.map((question) => ({
    ...question,
    choices: question.choices.map((choice, index) => {
      const letter = String.fromCharCode(65 + index);
      return `${letter}. ${letter}. ${choice}`;
    }),
  }));
  const parsedQuiz = parseStudyQuiz(JSON.stringify(exam));
  const response = renderStudyQuiz({
    id: '00000000-0000-0000-0000-000000000000',
    ...parsedQuiz,
    answers: new Array(parsedQuiz.questions.length).fill(null),
    questionIndex: 0,
    status: 'answering',
  });

  assert.deepEqual(
    response.components[0].components.map((button) => button.label),
    ['A. First choice', 'B. Second choice', 'C. Third choice', 'D. Fourth choice'],
  );
});

test('choice normalization preserves a subject term that resembles a label', () => {
  const exam = JSON.parse(createValidExam());
  exam.questions[0].choices = ['First choice', 'Second choice', 'C. elegans', 'Fourth choice'];

  const parsedQuiz = parseStudyQuiz(JSON.stringify(exam));

  assert.equal(parsedQuiz.questions[0].choices[2], 'C. elegans');
});

test('exam instructions avoid testing the paper layout instead of its subject matter', async () => {
  const request = await buildStudyOpenRouterRequest({ name: 'exam', topic: 'US civil rights movement' });

  assert.match(request.systemPrompt, /test the underlying subject matter/);
  assert.match(request.systemPrompt, /question numbers, section labels, marks, or wording/);
  assert.match(request.systemPrompt, /without a letter or prefix/);
});

test('study guides use bounded chunks, continuations, and no hidden reasoning', async () => {
  const guideRequest = await buildStudyOpenRouterRequest({ name: 'guide', topic: 'Database fundamentals' });
  assert.equal(guideRequest.maxTokens, 3000);
  assert.equal(guideRequest.maxContinuations, 2);
  assert.deepEqual(guideRequest.reasoning, { enabled: false });
  assert.deepEqual(guideRequest.tools, [{ type: 'openrouter:web_search' }]);
});

test('a truncated first response is replaced by one complete retry', async () => {
  let retryCalls = 0;
  const parsedQuiz = await parseStudyQuizWithRetry(
    '{"title":"AI Essentials Mock Exam","questions":[{"question":"unfinished',
    request,
    async () => {
      retryCalls += 1;
      return createValidExam();
    },
  );

  assert.equal(retryCalls, 1);
  assert.equal(parsedQuiz.questions.length, 5);
});

test('a truncated exam retries once from scratch, then returns a safe error if still invalid', async () => {
  let retryCalls = 0;
  let retryRequest;

  await assert.rejects(
    parseStudyQuizWithRetry(
      '{"title":"AI Essentials Mock Exam","questions":[{"question":"unfinished',
      request,
      async (value) => {
        retryCalls += 1;
        retryRequest = value;
        return '{"title":"still incomplete"';
      },
    ),
    (error) => {
      assert.ok(error instanceof StudyQuizError);
      assert.equal(error.userMessage, "I couldn't create a complete five-question quiz. Please try again.");
      assert.doesNotMatch(error.userMessage, /AI Essentials|unfinished|JSON/);
      return true;
    },
  );

  assert.equal(retryCalls, 1);
  assert.match(retryRequest.systemPrompt, /Start over and generate the complete exam/);
  assert.deepEqual(retryRequest.reasoning, { enabled: false });
  assert.deepEqual(retryRequest.responseFormat, request.responseFormat);
  assert.equal(retryRequest.userContent, request.userContent);
});
