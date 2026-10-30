import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStudyOpenRouterRequest,
  parseStudyQuiz,
  parseStudyQuizWithRetry,
  renderStudyQuiz,
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

test('answer feedback bolds the correct answer and uses no check or cross emoji', () => {
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
  assert.match(response.content, /Your answer: B\. Second choice/);
  assert.match(response.content, /Correct answer: \*\*A\. First choice\*\*/);
  assert.doesNotMatch(response.content, /✅|❌|▫️/);
});

test('missed-answer review bolds only the correct choice and uses no check or cross emoji', () => {
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

  assert.match(response.content, /\*\*A\. First choice\*\*/);
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
