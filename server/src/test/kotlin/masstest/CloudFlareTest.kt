package masstest

import eu.kanade.tachiyomi.source.online.HttpSource
import io.github.oshai.kotlinlogging.KotlinLogging
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.Assumptions.assumeTrue
import suwayomi.tachidesk.manga.impl.Source
import suwayomi.tachidesk.manga.impl.extension.Extension
import suwayomi.tachidesk.manga.impl.extension.ExtensionsList
import suwayomi.tachidesk.manga.impl.util.source.GetCatalogueSource
import suwayomi.tachidesk.server.applicationSetup
import suwayomi.tachidesk.test.BASE_PATH
import suwayomi.tachidesk.test.setLoggingEnabled
import xyz.nulldev.ts.config.CONFIG_PREFIX
import java.io.File

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class CloudFlareTest {
    lateinit var nhentai: HttpSource

    @BeforeAll
    fun setup() {
        val dataRoot = File(BASE_PATH).absolutePath
        System.setProperty("$CONFIG_PREFIX.server.rootDir", dataRoot)
        applicationSetup()
        setLoggingEnabled(false)

        runBlocking {
            val extensions = ExtensionsList.getExtensionList()
            val nhentaiExtension = extensions.firstOrNull { it.name == "NHentai" }
            assumeTrue(nhentaiExtension != null, "NHentai extension is not available")

            with(nhentaiExtension!!) {
                if (!installed) {
                    Extension.installExtension(pkgName)
                } else if (hasUpdate) {
                    Extension.updateExtension(pkgName)
                }
                Unit
            }

            val nhentaiSource =
                Source
                    .getSourceList()
                    .firstOrNull { it.id.toLong() == 3122156392225024195L }
            assumeTrue(nhentaiSource != null, "NHentai source is not available")

            nhentai =
                GetCatalogueSource.getCatalogueSourceOrNull(nhentaiSource!!.id.toLong()) as HttpSource
        }
        setLoggingEnabled(true)
    }

    private val logger = KotlinLogging.logger {}

    @Test
    fun `test nhentai browse`() =
        runTest {
            assert(nhentai.getPopularManga(1).mangas.isNotEmpty()) {
                "NHentai results were empty"
            }
        }
}
