import tutorLogic, { type TutorQuery } from '../logic/tutor-logic.js';
import { withHRC } from './hrcWrapper.js';

export const ArcanosTutor = {
  name: 'ARCANOS:TUTOR',
  description:
    'Professional tutoring kernel with dynamic schema binding, modular instruction, audit traceability, and feedback loops.',
  gptIds: ['arcanos-tutor', 'tutor'],
  actions: {
    async query(payload: TutorQuery) {
      const result = await tutorLogic.dispatch(payload);
      return withHRC(result, r => r.arcanos_tutor);
    },
  },
};

export default ArcanosTutor;

