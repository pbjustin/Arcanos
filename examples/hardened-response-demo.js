import { hardenedInternetResponse } from '../src/utils/hardenedResponse';
async function run() {
    const query = 'Who won the 2020 Nobel Prize in Literature?';
    const webData = {
        summary: 'The 2020 Nobel Prize in Literature was awarded to Louise Glück for her unmistakable poetic voice that with austere beauty makes individual existence universal.'
    };
    const result = await hardenedInternetResponse(query, webData);
    console.log(JSON.stringify(result, null, 2));
}
run().catch((err) => {
    console.error('Error running demo:', err);
});
