import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const integers = {
  i32: { kotlin: 'Int', bits: 32 },
  i64: { kotlin: 'Long', bits: 64 },
};

function route(operation, index, kotlinPackage) {
  const args = Object.entries(operation.args);
  const values = args.map(([name, type]) => `read${integers[type].kotlin}(payload, ${JSON.stringify(name)})`);
  const path = `/rpc/${operation.jsName}`;
  return `    @PostMapping(${JSON.stringify(path)}, consumes = [MediaType.APPLICATION_JSON_VALUE], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun operation${index}(@RequestBody payload: JsonNode): ${integers[operation.returns].kotlin} {
        if (!payload.isObject || payload.size() != ${args.length}) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a JSON object with ${args.length} RPC arguments")
        }
        return ${kotlinPackage}.\`${operation.jsName}\`(${values.join(', ')})
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

export async function writeSpringRpcServer(directory, sdk) {
  const source = join(directory, 'src/main/kotlin/dev/rustinside/rpc');
  await mkdir(source, { recursive: true });
  const numericArguments = new Set(sdk.exports.flatMap(operation => Object.values(operation.args)));
  const readers = [...numericArguments].map(readInteger).join('\n\n');
  const routes = sdk.exports.map((operation, index) => route(operation, index, sdk.kotlinPackage));
  const application = `package dev.rustinside.rpc

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.boot.autoconfigure.SpringBootApplication
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
class RpcController {
${routes.join('\n\n')}
}
${readers ? `\n${readers}\n` : ''}`;
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
    implementation 'net.java.dev.jna:jna:5.17.0'
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
