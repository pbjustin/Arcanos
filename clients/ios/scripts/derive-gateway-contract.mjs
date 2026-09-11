// Extract data with the TypeScript AST; never import the backend's DB/provider graph.
// Run from any directory: node clients/ios/scripts/derive-gateway-contract.mjs [--check]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const require = createRequire(resolve(root, 'package.json'));
const compilerFlag = process.argv.indexOf('--typescript');
const ts = require(compilerFlag >= 0 ? resolve(process.argv[compilerFlag + 1]) : 'typescript');
const sourcePath = 'src/services/gptAccessGateway.ts';
const sourceText = await readFile(resolve(root, sourcePath), 'utf8');
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
const constants = new Map();
for (const statement of source.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, declaration.initializer);
    }
  }
}

function literal(node) {
  if (!node) throw new Error('Missing contract initializer');
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && constants.has(node.text)) return literal(constants.get(node.text));
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map(property => {
      if (!ts.isPropertyAssignment(property)) throw new Error('Non-literal schema property');
      return [property.name.text, literal(property.initializer)];
    }));
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => String(literal(span.expression)) + span.literal.text).join('');
  }
  throw new Error(`Unsupported schema expression: ${node.getText(source).slice(0, 100)}`);
}
function property(object, key) {
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`Expected object: ${key}`);
  const found = object.properties.find(item => ts.isPropertyAssignment(item) && item.name.text === key);
  if (!found) throw new Error(`Missing contract property ${key}`);
  return found.initializer;
}
const builder = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildGptAccessOpenApiDocument');
// Security declarations are local literals in the canonical builder.
for (const statement of builder?.body?.statements ?? []) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, declaration.initializer);
    }
  }
}
const returned = builder?.body?.statements.find(ts.isReturnStatement)?.expression;
const schemaObject = property(property(returned, 'components'), 'schemas');
const names = [
  'ConfirmationChallenge', 'ConfirmationRequiredResponse', 'ErrorResponse',
  'CreateAiJobRequest', 'CreateAiJobResponse', 'JobResultRequest', 'JobResultError', 'JobResultResponse',
  'CapabilityV1Summary', 'CapabilityV1Detail', 'CapabilitiesV1Response', 'CapabilityV1DetailResponse',
  'CapabilityRunRequest', 'CapabilityRunResponse',
  'DevicePairingRequest', 'DevicePairingResponse', 'DevicePairRequest',
  'DeviceCredentialResponse', 'DeviceSessionResponse', 'DeviceRenewRequest',
  'DeviceRevokeRequest', 'DeviceRevokeResponse'
];
const schemas = Object.fromEntries(names.map(name => [name, literal(property(schemaObject, name))]));
const pathObject = property(returned, 'paths');
const operationNames = [
  ['/gpt-access/jobs/create', 'post'], ['/gpt-access/jobs/result', 'post'],
  ['/gpt-access/capabilities/v1', 'get'], ['/gpt-access/capabilities/v1/{id}', 'get'],
  ['/gpt-access/capabilities/v1/{id}/run', 'post'],
  ['/gpt-access/devices/pairing', 'post'], ['/gpt-access/devices/pair', 'post'],
  ['/gpt-access/devices/session', 'get'], ['/gpt-access/devices/renew', 'post'],
  ['/gpt-access/devices/{deviceId}/revoke', 'post']
];
const operations = operationNames.map(([path, method]) => {
  const operation = property(property(pathObject, path), method);
  return {
    path, method, operationId: literal(property(operation, 'operationId')),
    security: literal(property(operation, 'security'))
  };
});
const securitySchemes = literal(property(property(returned, 'components'), 'securitySchemes'));

const declarations = new Map();
const identifier = value => value === 'confirmation_token' ? 'confirmationToken' : value;
const capitalize = value => value[0].toUpperCase() + value.slice(1);
function swiftType(schema, name) {
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  if (schema.anyOf) return swiftType(schema.anyOf.find(item => item.type !== 'null'), name);
  const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
  if (type === 'string') return 'String';
  if (type === 'integer') return 'Int';
  if (type === 'number') return 'Double';
  if (type === 'boolean') return 'Bool';
  if (type === 'array') return `[${swiftType(schema.items, name + 'Item')}]`;
  if (type === 'object') {
    if (schema.properties) { emit(name, schema); return name; }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') return `[String: ${swiftType(schema.additionalProperties, name + 'Value')}]`;
    return '[String: JSONValue]';
  }
  return 'JSONValue';
}
function emit(name, schema) {
  if (declarations.has(name)) return;
  declarations.set(name, '');
  const fields = Object.entries(schema.properties).map(([key, value]) => {
    const optional = !schema.required?.includes(key) || (Array.isArray(value.type) && value.type.includes('null')) || value.anyOf?.some(item => item.type === 'null');
    return { key, name: identifier(key), type: swiftType(value, name + capitalize(identifier(key))), optional };
  });
  const properties = fields.map(field => `    public let ${field.name}: ${field.type}${field.optional ? '?' : ''}`).join('\n');
  const argumentsText = fields.map(field => `${field.name}: ${field.type}${field.optional ? '? = nil' : ''}`).join(', ');
  const assignments = fields.map(field => `        self.${field.name} = ${field.name}`).join('\n');
  const sensitive = Object.values(schema.properties).some(value => value['x-arcanos-sensitive'] === true);
  const redactedDescription = sensitive
    ? `\n    public var description: String { "${name}(<redacted>)" }\n    public var debugDescription: String { description }\n`
    : '';
  const keys = fields.some(field => field.key !== field.name)
    ? '\n    enum CodingKeys: String, CodingKey {\n' + fields.map(field => `        case ${field.name}${field.name !== field.key ? ` = "${field.key}"` : ''}`).join('\n') + '\n    }\n'
    : '';
  declarations.set(name, `public struct ${name}: Codable, Equatable, Sendable${sensitive ? ', CustomStringConvertible, CustomDebugStringConvertible' : ''} {\n${properties}\n\n    public init(${argumentsText}) {\n${assignments}\n    }\n${keys}${redactedDescription}}\n`);
}
for (const [name, schema] of Object.entries(schemas)) emit(name, schema);
const swift = '// Generated by clients/ios/scripts/derive-gateway-contract.mjs. Do not edit.\n'
  + `// Source: ${sourcePath}, buildGptAccessOpenApiDocument.\n`
  + '// JSON schemas remain authoritative for validation; these are transport DTOs.\n\nimport Foundation\n\n'
  + [...declarations.values()].join('\n')
  + '\npublic typealias CreateAIJobRequest = CreateAiJobRequest\npublic typealias CreateAIJobResponse = CreateAiJobResponse\n';
const snapshot = JSON.stringify({ source: sourcePath, openapi: '3.1.0', securitySchemes, operations, schemas }, null, 2) + '\n';
const outputs = [
  [resolve(here, '../ArcanosKit/Sources/ArcanosKit/Models/GatewayModels.generated.swift'), swift],
  [resolve(here, 'gateway-contract.generated.json'), snapshot]
];
for (const [path, expected] of outputs) {
  if (process.argv.includes('--check')) {
    const actual = await readFile(path, 'utf8');
    if (actual.replace(/\r\n/g, '\n') !== expected) throw new Error(`Generated iOS contract drift: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected);
  }
}
console.log(`iOS Gateway contract ${process.argv.includes('--check') ? 'verified' : 'generated'}: ${names.length} schemas, ${operations.length} operations.`);
