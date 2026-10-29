import { ButtonStyleTypes, MessageComponentTypes } from 'discord-interactions';

const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];
const MAX_DISCORD_MESSAGE_LENGTH = 2000;

export class StudyQuizError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

function normalizeText(value, maxLength = Infinity) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStudyExamJson(answer) {
  const candidate = typeof answer === 'string' ? answer.trim() : '';
  if (!candidate) return null;

  const wholeAnswer = parseJsonObject(candidate);
  if (wholeAnswer) return wholeAnswer;

  // Accept a JSON object wrapped in prose or a Markdown code fence. Track quoted
  // braces so strings such as explanations containing "{...}" do not end early.
  for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonObject(candidate.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

function hasExactKeys(value, expectedKeys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

export function parseStudyQuiz(answer, expectedQuestionCount) {
  const parsed = extractStudyExamJson(answer);
  if (!hasExactKeys(parsed, ['title', 'questions'])) {
    throw new StudyQuizError('I could not format the generated exam as a quiz. Please try again.');
  }

  const title = normalizeText(parsed.title);
  if (!title) {
    throw new StudyQuizError('The generated exam did not include a title. Please try again.');
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== expectedQuestionCount) {
    throw new StudyQuizError('The generated exam did not contain the requested number of questions. Please try again.');
  }

  const questions = parsed.questions.map((item) => {
    const question = normalizeText(item?.question);
    const explanation = normalizeText(item?.explanation);
    const choices = Array.isArray(item?.choices)
      ? item.choices.map((choice) => normalizeText(choice))
      : [];

    if (
      !hasExactKeys(item, ['question', 'choices', 'correctIndex', 'explanation']) ||
      !question ||
      !explanation ||
      choices.length !== 4 ||
      choices.some((choice) => !choice) ||
      new Set(choices.map((choice) => choice.toLowerCase())).size !== 4 ||
      !Number.isInteger(item?.correctIndex) ||
      item.correctIndex < 0 ||
      item.correctIndex > 3
    ) {
      throw new StudyQuizError('One generated question was incomplete. Please run the exam again.');
    }

    return { question, choices, correctIndex: item.correctIndex, explanation };
  });

  validateQuizMessageLengths(title, questions);
  return { title, questions };
}

function quizButton(sessionId, action, label, style, context, extra = {}) {
  return {
    type: MessageComponentTypes.BUTTON,
    custom_id: `study_quiz:${sessionId}:${action}${Number.isInteger(context) ? `:${context}` : ''}`,
    label,
    style,
    ...extra,
  };
}

function answerButton(sessionId, question, questionIndex, choiceIndex, selectedIndex, disabled) {
  let style = ButtonStyleTypes.SECONDARY;
  if (disabled && choiceIndex === question.correctIndex) style = ButtonStyleTypes.SUCCESS;
  else if (disabled && choiceIndex === selectedIndex) style = ButtonStyleTypes.DANGER;

  return {
    type: MessageComponentTypes.BUTTON,
    custom_id: `study_quiz:${sessionId}:answer:${questionIndex}:${choiceIndex}`,
    label: ANSWER_LETTERS[choiceIndex],
    style,
    disabled,
  };
}

function answerRow(sessionId, question, questionIndex, selectedIndex = null, disabled = false) {
  return {
    type: MessageComponentTypes.ACTION_ROW,
    components: question.choices.map((_, choiceIndex) =>
      answerButton(sessionId, question, questionIndex, choiceIndex, selectedIndex, disabled)),
  };
}

function getScore(quiz) {
  return quiz.answers.reduce((score, answer, index) =>
    score + (answer === quiz.questions[index].correctIndex ? 1 : 0), 0);
}

function getMissedQuestionIndexes(quiz) {
  return quiz.answers.reduce((indexes, answer, index) => {
    if (answer !== quiz.questions[index].correctIndex) indexes.push(index);
    return indexes;
  }, []);
}

function getScoreLabel(quiz) {
  const score = getScore(quiz);
  const total = quiz.questions.length;
  return `${score}/${total} (${Math.round((score / total) * 100)}%)`;
}

function formatChoices(question, selectedIndex = null) {
  return question.choices.map((choice, index) => {
    const marker = selectedIndex === null
      ? ''
      : index === question.correctIndex
        ? '✅ '
        : index === selectedIndex
          ? '❌ '
          : '▫️ ';
    return `${marker}${ANSWER_LETTERS[index]}. ${choice}`;
  }).join('\n');
}

function getReviewContent(quiz) {
  const questionIndex = quiz.reviewIndexes[quiz.reviewIndex];
  const question = quiz.questions[questionIndex];
  const selectedIndex = quiz.answers[questionIndex];
  return [
    `**Review missed answers · ${quiz.reviewIndex + 1}/${quiz.reviewIndexes.length}**`,
    `Score: ${getScoreLabel(quiz)}`,
    '',
    question.question,
    '',
    formatChoices(question, selectedIndex),
    '',
    `**Why:** ${question.explanation}`,
  ].join('\n');
}

export function renderStudyQuiz(quiz) {
  const question = quiz.questions[quiz.questionIndex];

  if (quiz.status === 'answering') {
    return {
      content: [
        `**${quiz.title}**\nQuestion ${quiz.questionIndex + 1}/${quiz.questions.length}`,
        '',
        question.question,
        '',
        formatChoices(question),
      ].join('\n'),
      components: [answerRow(quiz.id, question, quiz.questionIndex)],
    };
  }

  if (quiz.status === 'feedback') {
    const selectedIndex = quiz.answers[quiz.questionIndex];
    const correct = selectedIndex === question.correctIndex;
    const nextLabel = quiz.questionIndex === quiz.questions.length - 1 ? 'See results' : 'Next question';
    return {
      content: [
        `**${quiz.title}** · Question ${quiz.questionIndex + 1}/${quiz.questions.length}`,
        '',
        question.question,
        '',
        formatChoices(question, selectedIndex),
        '',
        `${correct ? '✅ Correct!' : '❌ Not quite.'} Your answer: **${ANSWER_LETTERS[selectedIndex]}** · Correct answer: **${ANSWER_LETTERS[question.correctIndex]}**`,
        '',
        `**Why:** ${question.explanation}`,
      ].join('\n'),
      components: [
        answerRow(quiz.id, question, quiz.questionIndex, selectedIndex, true),
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [quizButton(quiz.id, 'next', nextLabel, ButtonStyleTypes.PRIMARY, quiz.questionIndex)],
        },
      ],
    };
  }

  if (quiz.status === 'review') {
    const previousDisabled = quiz.reviewIndex === 0;
    const nextDisabled = quiz.reviewIndex === quiz.reviewIndexes.length - 1;
    return {
      content: getReviewContent(quiz),
      components: [{
        type: MessageComponentTypes.ACTION_ROW,
        components: [
          quizButton(quiz.id, 'previous', 'Previous', ButtonStyleTypes.SECONDARY, quiz.reviewIndex, { disabled: previousDisabled }),
          quizButton(quiz.id, 'review_next', 'Next missed answer', ButtonStyleTypes.PRIMARY, quiz.reviewIndex, { disabled: nextDisabled }),
          quizButton(quiz.id, 'score', 'Back to score', ButtonStyleTypes.SUCCESS),
        ],
      }],
    };
  }

  const missedCount = getMissedQuestionIndexes(quiz).length;
  return {
    content: missedCount === 0
      ? `**${quiz.title} complete**\n\nScore: **${getScoreLabel(quiz)}**\nPerfect score — you got every question right.`
      : `**${quiz.title} complete**\n\nScore: **${getScoreLabel(quiz)}**\nYou missed ${missedCount} ${missedCount === 1 ? 'question' : 'questions'}. Review them below.`,
    components: missedCount === 0
      ? []
      : [{
        type: MessageComponentTypes.ACTION_ROW,
        components: [quizButton(quiz.id, 'review', `Review missed answers (${missedCount})`, ButtonStyleTypes.PRIMARY)],
      }],
  };
}

function validateQuizMessageLengths(title, questions) {
  const quizId = '00000000-0000-0000-0000-000000000000';
  const answers = new Array(questions.length).fill(null);

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const question = questions[questionIndex];
    const incorrectChoice = (question.correctIndex + 1) % question.choices.length;
    const feedbackAnswers = [...answers];
    feedbackAnswers[questionIndex] = incorrectChoice;
    const reviewAnswers = questions.map((item) => (item.correctIndex + 1) % item.choices.length);
    const scenarios = [
      {
        id: quizId,
        title,
        questions,
        answers,
        questionIndex,
        status: 'answering',
      },
      {
        id: quizId,
        title,
        questions,
        answers: feedbackAnswers,
        questionIndex,
        status: 'feedback',
      },
      {
        id: quizId,
        title,
        questions,
        answers: reviewAnswers,
        questionIndex,
        status: 'review',
        reviewIndexes: new Array(questions.length).fill(questionIndex),
        reviewIndex: questions.length - 1,
      },
    ];

    if (scenarios.some((quiz) => renderStudyQuiz(quiz).content.length > MAX_DISCORD_MESSAGE_LENGTH)) {
      throw new StudyQuizError('A generated question and its full answer choices are too long to display in Discord. Please run the exam again.');
    }
  }
}

export function getMissedQuestionIndexesForReview(quiz) {
  return getMissedQuestionIndexes(quiz);
}
