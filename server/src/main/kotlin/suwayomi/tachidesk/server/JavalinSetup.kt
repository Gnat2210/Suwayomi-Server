package suwayomi.tachidesk.server

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import android.app.Application
import android.content.Context as AndroidContext
import gg.jte.ContentType
import gg.jte.TemplateEngine
import io.github.oshai.kotlinlogging.KotlinLogging
import io.javalin.Javalin
import io.javalin.http.staticfiles.Location
import org.eclipse.jetty.server.handler.ContextHandler
import io.javalin.apibuilder.ApiBuilder.after
import io.javalin.apibuilder.ApiBuilder.path
import io.javalin.http.Context
import io.javalin.http.HandlerType
import io.javalin.http.HttpStatus
import io.javalin.http.NotFoundResponse
import io.javalin.http.RedirectResponse
import io.javalin.http.UnauthorizedResponse
import io.javalin.rendering.template.JavalinJte
import io.javalin.websocket.WsContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.future.future
import org.eclipse.jetty.server.ServerConnector
import suwayomi.tachidesk.global.GlobalAPI
import suwayomi.tachidesk.graphql.GraphQL
import suwayomi.tachidesk.graphql.types.AuthMode
import suwayomi.tachidesk.i18n.LocalizationHelper
import suwayomi.tachidesk.manga.MangaAPI
import suwayomi.tachidesk.opds.OpdsAPI
import suwayomi.tachidesk.server.user.ForbiddenException
import suwayomi.tachidesk.server.user.UnauthorizedException
import suwayomi.tachidesk.server.user.UserType
import suwayomi.tachidesk.server.user.getUserFromContext
import suwayomi.tachidesk.server.user.getUserFromWsContext
import suwayomi.tachidesk.server.util.Browser
import suwayomi.tachidesk.server.util.ServerSubpath
import suwayomi.tachidesk.server.util.WebInterfaceManager
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import uy.kohesive.injekt.injectLazy
import suwayomi.tachidesk.server.ApplicationDirs
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.CompletableFuture
import kotlin.concurrent.thread
import kotlin.time.Duration.Companion.days

object JavalinSetup {
    private val logger = KotlinLogging.logger {}

    private const val UI_MODE_PREFS = "server_ui_mode"
    private const val UI_MODE_KEY = "useKindleUi"

    // runtime flag to choose UI mode. true = serve Kindle UI at `/`, false = serve original Web UI
    private val uiModePreferences =
        Injekt.get<Application>().getSharedPreferences(UI_MODE_PREFS, AndroidContext.MODE_PRIVATE)

    private var useKindleUi: Boolean = uiModePreferences.getBoolean(UI_MODE_KEY, true)

    private val applicationDirs: ApplicationDirs by injectLazy()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun serveKindleAsset(
        ctx: Context,
        assetName: String,
        contentType: String,
    ) {
        val stream = JavalinSetup::class.java.getResourceAsStream("/kindle/$assetName") ?: throw NotFoundResponse()

        ctx.header("Cache-Control", "no-store")
        ctx.contentType(contentType)
        ctx.result(stream)
    }

    fun <T> future(block: suspend CoroutineScope.() -> T): CompletableFuture<T> = scope.future(block = block)

    fun javalinSetup() {
        val app =
            Javalin.create { config ->
                val templateEngine = TemplateEngine.createPrecompiled(ContentType.Html)
                config.fileRenderer(JavalinJte(templateEngine))

                // Serve Kindle UI from classpath first so it overrides any extracted/custom Web UI
                val kindleHosted = ServerSubpath.maybeAddAsPrefix("/kindle")
                config.staticFiles.add { staticFiles ->
                    staticFiles.hostedPath = kindleHosted
                    staticFiles.directory = "kindle"
                    staticFiles.location = Location.CLASSPATH
                    staticFiles.aliasCheck = ContextHandler.ApproveAliases()
                    staticFiles.headers = mapOf("Cache-Control" to "no-store")
                }

                WebInterfaceManager.setup(config)

                // config.registerPlugin(OpenApiPlugin(getOpenApiOptions()))

                var connectorAdded = false
                config.jetty.modifyServer { server ->
                    if (!connectorAdded) {
                        val connector =
                            ServerConnector(server).apply {
                                host = serverConfig.ip.value
                                port = serverConfig.port.value
                            }
                        server.addConnector(connector)

                        serverConfig.subscribeTo(
                            combine(
                                serverConfig.ip,
                                serverConfig.port,
                            ) { ip, port -> Pair(ip, port) },
                            { (newIp, newPort) ->
                                val oldIp = connector.host
                                val oldPort = connector.port

                                connector.host = newIp
                                connector.port = newPort
                                connector.stop()
                                connector.start()

                                logger.info { "Server ip and/or port changed from $oldIp:$oldPort to $newIp:$newPort " }
                            },
                        )
                        connectorAdded = true
                    }
                }

                config.bundledPlugins.enableCors { cors ->
                    cors.addRule {
                        it.allowCredentials = true
                        it.reflectClientOrigin = true
                    }
                }

                config.router.apiBuilder {
                    path(ServerSubpath.maybeAddAsPrefix("api/")) {
                        path("v1/") {
                            GlobalAPI.defineEndpoints()
                            MangaAPI.defineEndpoints()
                        }

                        OpdsAPI.defineEndpoints()
                        GraphQL.defineEndpoints()

                        after { ctx ->
                            // If not matched, the request was for an invalid endpoint
                            // Return a 404 instead of redirecting to the UI for usability
                            if (ctx.endpointHandlerPath() == "*") {
                                throw NotFoundResponse()
                            }
                        }
                    }
                }
            }

        val loginPath = ServerSubpath.maybeAddAsPrefix("/login.html")

        app.get(loginPath) { ctx ->
            val locale: Locale = LocalizationHelper.ctxToLocale(ctx)
            ctx.header("content-type", "text/html")
            val httpCacheSeconds = 1.days.inWholeSeconds
            ctx.header("cache-control", "max-age=$httpCacheSeconds")
            ctx.render(
                "Login.jte",
                mapOf(
                    "locale" to locale,
                    "error" to "",
                ),
            )
        }

        app.post(loginPath) { ctx ->
            val username = ctx.formParam("user")
            val password = ctx.formParam("pass")
            val isValid =
                username == serverConfig.authUsername.value &&
                    password == serverConfig.authPassword.value

            if (isValid) {
                val redirect = ctx.queryParam("redirect") ?: ServerSubpath.maybeAddAsPrefix("/")
                val uri = URI(redirect)
                if (uri.host != null || uri.scheme != null) {
                    throw IllegalArgumentException("Given redirect is not relative, refusing")
                }
                // NOTE: We currently have no session handler attached.
                // Thus, all sessions are stored in memory and not persisted.
                // Furthermore, default session timeout appears to be 30m
                ctx.header("Location", redirect)
                ctx.sessionAttribute("logged-in", username)
                throw RedirectResponse(HttpStatus.SEE_OTHER)
            }

            val locale: Locale = LocalizationHelper.ctxToLocale(ctx)
            ctx.header("content-type", "text/html")
            ctx.req().session.invalidate()
            ctx.render(
                "Login.jte",
                mapOf(
                    "locale" to locale,
                    "error" to "Invalid username or password",
                ),
            )
        }

        val kindlePath = ServerSubpath.maybeAddAsPrefix("/kindle")
        val webuiPath = ServerSubpath.maybeAddAsPrefix("/webui")
        val rootPath = ServerSubpath.asRootPath()

        // Root handler: redirect to Kindle UI or serve original Web UI index depending on `useKindleUi`
        app.get(rootPath) { ctx ->
            if (useKindleUi) {
                ctx.redirect("$kindlePath/")
                return@get
            }

            // Try to serve the original Web UI index.html from the temp servable directory
            val indexFile = File(applicationDirs.webUIServe, "index.html")
            if (indexFile.exists()) {
                ctx.header("content-type", "text/html")
                ctx.header("cache-control", "max-age=0")
                ctx.result(indexFile.readText())
            } else {
                // fallback: redirect to root so WebInterfaceManager can initialize/serve
                ctx.redirect(ServerSubpath.asRootPath())
            }
        }

        // Serve original web UI under /webui as well
        app.get(webuiPath) { ctx ->
            val indexFile = File(applicationDirs.webUIServe, "index.html")
            if (indexFile.exists()) {
                ctx.header("content-type", "text/html")
                ctx.header("cache-control", "max-age=0")
                ctx.result(indexFile.readText())
            } else {
                ctx.status(HttpStatus.NOT_FOUND)
                ctx.result("Web UI not available")
            }
        }

        app.beforeMatched { ctx ->
            val isWebManifest =
                listOf("site.webmanifest", "manifest.json", "login.html").any { ctx.path().endsWith(it) }
            val isKindleUi = ctx.path().startsWith(kindlePath)
            val isLandingPage = ctx.path() == rootPath
            val isPageIcon =
                ctx.path().startsWith('/') &&
                    !ctx.path().substring(1).contains('/') &&
                    listOf(".png", ".jpg", ".ico").any { ctx.path().endsWith(it) }
            val isPreFlight = ctx.method() == HandlerType.OPTIONS
            val isApi = ctx.path().startsWith(ServerSubpath.maybeAddAsPrefix("/api/"))

            val requiresAuthentication = !isPreFlight && !isPageIcon && !isWebManifest && !isKindleUi && !isLandingPage
            if (!requiresAuthentication) {
                return@beforeMatched
            }

            val authMode = serverConfig.authMode.value

            fun credentialsValid(): Boolean {
                val basicAuthCredentials = ctx.basicAuthCredentials() ?: return false
                val (username, password) = basicAuthCredentials
                return username == serverConfig.authUsername.value &&
                    password == serverConfig.authPassword.value
            }

            fun cookieValid(): Boolean {
                val username = ctx.sessionAttribute<String>("logged-in") ?: return false
                return username == serverConfig.authUsername.value
            }

            if (authMode == AuthMode.SIMPLE_LOGIN && !cookieValid() && !isApi && !isKindleUi) {
                val url =
                    "$loginPath?redirect=" + URLEncoder.encode(ctx.path() + (ctx.queryString()?.let { "?" + it } ?: ""), Charsets.UTF_8)
                ctx.header("Location", url)
                throw RedirectResponse(HttpStatus.SEE_OTHER)
            }

            if (authMode == AuthMode.BASIC_AUTH && !credentialsValid()) {
                ctx.header("WWW-Authenticate", "Basic")
                throw UnauthorizedResponse()
            }

            ctx.setAttribute(Attribute.TachideskUser, getUserFromContext(ctx))
            ctx.setAttribute(Attribute.TachideskBasic, credentialsValid())
        }

        app.events { event ->
            event.serverStarted {
                if (serverConfig.initialOpenInBrowserEnabled.value) {
                    Browser.openInBrowser()
                }
            }
        }

        app.wsBefore {
            it.onConnect { ctx ->
                ctx.setAttribute(Attribute.TachideskUser, getUserFromWsContext(ctx))
            }
        }

        // Admin endpoints to get/set UI mode at runtime
        val apiRoot = ServerSubpath.maybeAddAsPrefix("/api/v1/")
        app.get("${apiRoot}ui-mode") { ctx ->
            ctx.contentType("application/json")
            ctx.result(
                "{\"mode\":\"${if (useKindleUi) "kindle" else "original"}\"}"
            )
        }

        app.post("${apiRoot}ui-mode") { ctx ->
            try {
                val body = ctx.body()
                val mode = if (body.contains("kindle")) "kindle" else if (body.contains("original")) "original" else null

                if (mode == null) {
                    ctx.status(HttpStatus.BAD_REQUEST)
                    ctx.result("invalid payload")
                    return@post
                }

                useKindleUi = mode == "kindle"
                uiModePreferences.edit().putBoolean(UI_MODE_KEY, useKindleUi).apply()
                ctx.status(HttpStatus.NO_CONTENT)
            } catch (e: Exception) {
                ctx.status(HttpStatus.BAD_REQUEST)
                ctx.result("invalid payload")
            }
        }

        // when JVM is prompted to shutdown, stop javalin gracefully
        Runtime.getRuntime().addShutdownHook(
            thread(start = false) {
                app.stop()
            },
        )

        app.exception(NullPointerException::class.java) { e, ctx ->
            logger.error(e) { "NullPointerException while handling the request" }
            ctx.status(404)
        }
        app.exception(NoSuchElementException::class.java) { e, ctx ->
            logger.error(e) { "NoSuchElementException while handling the request" }
            ctx.status(404)
        }
        app.exception(IOException::class.java) { e, ctx ->
            logger.error(e) { "IOException while handling the request" }
            ctx.status(500)
            ctx.result(e.message ?: "Internal Server Error")
        }

        app.exception(IllegalArgumentException::class.java) { e, ctx ->
            logger.error(e) { "IllegalArgumentException while handling the request" }
            ctx.status(400)
            ctx.result(e.message ?: "Bad Request")
        }

        app.exception(UnauthorizedException::class.java) { e, ctx ->
            logger.error(e) { "UnauthorizedException while handling the request" }
            ctx.status(HttpStatus.UNAUTHORIZED)
            ctx.result(e.message ?: "Unauthorized")
        }

        app.exception(ForbiddenException::class.java) { e, ctx ->
            logger.error(e) { "ForbiddenException while handling the request" }
            ctx.status(HttpStatus.FORBIDDEN)
            ctx.result(e.message ?: "Forbidden")
        }

        app.start()
    }

    // private fun getOpenApiOptions(): OpenApiOptions {
    //     val applicationInfo =
    //         Info().apply {
    //             version("1.0")
    //             description("Suwayomi-Server Api")
    //         }
    //     return OpenApiOptions(applicationInfo).apply {
    //         path("/api/openapi.json")
    //         swagger(
    //             SwaggerOptions("/api/swagger-ui").apply {
    //                 title("Suwayomi-Server Swagger Documentation")
    //             },
    //         )
    //     }
    // }

    sealed class Attribute<T : Any>(
        val name: String,
    ) {
        data object TachideskUser : Attribute<UserType>("user")

        data object TachideskBasic : Attribute<Boolean>("basicAuthValid")
    }

    private fun <T : Any> Context.setAttribute(
        attribute: Attribute<T>,
        value: T,
    ) {
        attribute(attribute.name, value)
    }

    private fun <T : Any> WsContext.setAttribute(
        attribute: Attribute<T>,
        value: T,
    ) {
        attribute(attribute.name, value)
    }

    fun <T : Any> Context.getAttribute(attribute: Attribute<T>): T = attribute(attribute.name)!!

    fun <T : Any> WsContext.getAttribute(attribute: Attribute<T>): T = attribute(attribute.name)!!

    fun <T : Any> WsContext.getAttributeOrSet(
        attribute: Attribute<T>,
        replaceIf: (T) -> Boolean = { false },
        set: () -> T,
    ): T {
        var item: T? = attribute(attribute.name)

        if (item != null && replaceIf(item)) {
            item = null
        }

        return item ?: set().also { setAttribute(attribute, it) }
    }
}
