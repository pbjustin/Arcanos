import tutorLogic, { type TutorQuery } from '../logic/tutor-logic.js';

export const ArcanosTutor = {
  name: 'ARCANOS:TUTOR',
  description:
    'Professional tutoring kernel with dynamic schema binding, modular instruction, audit traceability, and feedback loops.',
  gptIds: ['arcanos-tutor', 'tutor'],
  actions: {
    async query(payload: TutorQuery) {
      return tutorLogic.dispatch(payload);
    },
  },
};

export default ArcanosTutor;

