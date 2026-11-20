import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const integers = {
  i32: { kotlin: 'Int', bits: 32 },
  i64: { kotlin: 'Long', bits: 64 },
};

const camelCase = name => name.replace(/_([a-z0-9])/g, (_, next) => next.toUpperCase());
const kotlinType = (type, pkg) => integers[type]?.kotlin ?? (type === 'String' ? type : `${pkg}.${type}`);
const readerType = type => integers[type]?.kotlin ?? type;
const completeEvent = operation => operation.jsName[0].toUpperCase() + operation.jsName.slice(1) + 'Completed';
const actorArgument = 'RpcContext';

function readObject(size, indent) {
  return `${indent}if (!payload.isObject || payload.size() != ${size}) {
${indent}    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a JSON object with ${size} RPC arguments")
${indent}}`;
}

function route(operation, index, sdk, enums, records) {
  const args = Object.entries(operation.args);
  const authenticated = args.some(([, type]) => type === actorArgument);
  const body = args.filter(([, type]) => type !== actorArgument);
  const values = args.map(([name, type]) => type === actorArgument
    ? `${sdk.kotlinPackage}.RpcContext(principal = actor.name, requestId = UUID.randomUUID().toString())`
    : `read${readerType(type)}(payload, ${JSON.stringify(name)})`);
  const path = `/rpc/${operation.jsName}`;
  const principal = authenticated ? ', principal: Principal?' : '';
  const actor = authenticated
    ? '        val actor = principal ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED)\n'
    : '';
  const completed = authenticated ? `        events.publishEvent(${completeEvent(operation)}(result))\n` : '';
  const result = wireValue(operation.returns, 'result', enums, records);
  return `    @PostMapping(${JSON.stringify(path)}, consumes = [MediaType.APPLICATION_JSON_VALUE], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun operation${index}(@RequestBody payload: JsonNode${principal}): JsonNode {
${actor}${readObject(body.length, '        ')}
        val result = ${sdk.kotlinPackage}.\`${operation.jsName}\`(${values.join(', ')})
${completed}        return json.valueToTree(${result})
    }`;
}

function readInteger(type) {
  const { kotlin, bits } = integers[type];
  return `private fun read${kotlin}(payload: JsonNode, name: String): ${kotlin} {
    val value = payload.path(name)
    if (!value.isIntegralNumber || !value.canConvertTo${kotlin}()) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a signed ${bits}-bit integer for $name")
    }
    return value.${kotlin.toLowerCase()}Value()
}`;
}

const readString = `private fun readString(payload: JsonNode, name: String): String {
    val value = payload.path(name)
    if (!value.isTextual) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a string for $name")
    }
    return value.textValue()
}`;

function readEnum(name, pkg) {
  return `private fun read${name}(payload: JsonNode, name: String): ${pkg}.${name} {
    val value = readString(payload, name)
    return try {
        ${pkg}.${name}.valueOf(value)
    } catch (_: IllegalArgumentException) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid ${name} for $name")
    }
}`;
}

function readRecord({ name, fields }, pkg) {
  const values = fields.map(field => `read${readerType(field.type)}(payload, ${JSON.stringify(field.name)})`);
  return `private fun read${name}(parent: JsonNode, name: String): ${pkg}.${name} {
    val payload = parent.path(name)
${readObject(fields.length, '    ')}
    return ${pkg}.${name}(${values.join(', ')})
}`;
}

function wireValue(type, value, enums, records) {
  if (enums.has(type)) return `${value}.name`;
  if (records.has(type)) return `write${type}(${value})`;
  return value;
}

function writeRecord({ name, fields }, pkg, enums, records) {
  const pairs = fields.map(field => {
    const value = wireValue(field.type, `value.\`${camelCase(field.name)}\``, enums, records);
    return `    ${JSON.stringify(field.name)} to ${value},`;
  });
  return `private fun write${name}(value: ${pkg}.${name}): Map<String, Any> = mapOf(
${pairs.join('\n')}
)`;
}

function reachableTypes(roots, records) {
  const types = new Set();
  function visit(type) {
    if (types.has(type) || type === actorArgument) return;
    types.add(type);
    for (const field of records.get(type)?.fields ?? []) visit(field.type);
  }
  for (const type of roots) visit(type);
  return [...types];
}

export async function writeSpringRpcServer(directory, sdk) {
  const source = join(directory, 'src/main/kotlin/dev/rustinside/rpc');
  await mkdir(source, { recursive: true });
  const enums = new Set((sdk.enums ?? []).map(({name}) => name));
  const records = new Map((sdk.records ?? []).map(record => [record.name, record]));
  const authenticated = sdk.exports.filter(operation => Object.values(operation.args).includes(actorArgument));
  const inputTypes = reachableTypes(sdk.exports.flatMap(operation => Object.values(operation.args)), records);
  const readers = inputTypes.filter(type => type !== 'String').map(type => {
    if (integers[type]) return readInteger(type);
    if (enums.has(type)) return readEnum(type, sdk.kotlinPackage);
    return readRecord(records.get(type), sdk.kotlinPackage);
  });
  if (inputTypes.includes('String') || inputTypes.some(type => enums.has(type))) readers.push(readString);
  const outputTypes = reachableTypes(sdk.exports.map(operation => operation.returns), records);
  const writers = outputTypes.filter(type => records.has(type))
    .map(type => writeRecord(records.get(type), sdk.kotlinPackage, enums, records));
  const routes = sdk.exports.map((operation, index) => route(operation, index, sdk, enums, records));
  const authImports = authenticated.length ? `import java.security.Principal
import java.util.UUID
import org.springframework.context.ApplicationEventPublisher
` : '';
  const events = authenticated.map(operation => `data class ${completeEvent(operation)}(val result: ${kotlinType(operation.returns, sdk.kotlinPackage)})`);
  const helpers = [...events, ...readers, ...writers];
  const eventsParameter = authenticated.length ? ', private val events: ApplicationEventPublisher' : '';
  const application = `package dev.rustinside.rpc

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
${authImports}import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

@SpringBootApplication(proxyBeanMethods = false)
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}

@RestController
class RpcController(private val json: ObjectMapper${eventsParameter}) {
${routes.join('\n\n')}
}
${helpers.length ? `\n${helpers.join('\n\n')}\n` : ''}`;
  const security = authenticated.length ? "    implementation 'org.springframework.boot:spring-boot-starter-security:3.5.16'\n" : '';
  const build = `plugins {
    id 'application'
    id 'org.jetbrains.kotlin.jvm' version '2.1.21'
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation files('../packages/${sdk.name}-jvm-${sdk.version}.jar')
    implementation 'org.springframework.boot:spring-boot-starter-web:3.5.16'
${security}    implementation 'net.java.dev.jna:jna:5.17.0'
    runtimeOnly 'org.jetbrains.kotlin:kotlin-reflect:2.1.0'
}

application {
    mainClass = 'dev.rustinside.rpc.ApplicationKt'
}
`;
  const settings = `pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories { mavenCentral() }
}

rootProject.name = 'rust-inside-rpc-server'
`;
  await Promise.all([
    writeFile(join(directory, 'settings.gradle'), settings),
    writeFile(join(directory, 'build.gradle'), build),
    writeFile(join(source, 'Application.kt'), application),
  ]);
}
