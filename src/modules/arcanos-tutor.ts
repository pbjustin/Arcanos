import tutorLogic from '../logic/tutor-logic.js';

export const ArcanosTutor = {
  name: 'ARCANOS:TUTOR',
  description: 'Modular tutoring kernel for memory-driven instruction, audit, and feedback loops.',
  actions: {
    async query(payload: any) {
      return tutorLogic.dispatch(payload);
    },
  },
};

export default ArcanosTutor;

