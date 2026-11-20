package dev.rustinside.rpc

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.event.EventListener
import org.springframework.security.config.Customizer.withDefaults
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.userdetails.User
import org.springframework.security.crypto.factory.PasswordEncoderFactories
import org.springframework.security.provisioning.InMemoryUserDetailsManager
import org.springframework.security.web.SecurityFilterChain
import org.springframework.stereotype.Component
import java.sql.DriverManager

@Configuration(proxyBeanMethods = false)
class ReportConfiguration {
    @Bean
    fun users(): InMemoryUserDetailsManager {
        val password = checkNotNull(System.getenv("REPORT_DEMO_PASSWORD"))
        val encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder()
        val martin = User.withUsername("martin").password(encoder.encode(password)).roles("USER").build()
        return InMemoryUserDetailsManager(martin)
    }

    @Bean
    fun security(http: HttpSecurity): SecurityFilterChain = http
        .authorizeHttpRequests { it.anyRequest().authenticated() }
        .httpBasic(withDefaults())
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        .csrf { it.disable() }
        .build()
}

@Component
class ReportStore {
    private val url = "jdbc:h2:file:${checkNotNull(System.getenv("REPORT_DATABASE"))}"

    init {
        DriverManager.getConnection(url, "sa", "").use { db ->
            db.createStatement().use { statement ->
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS reports (
                        report_id VARCHAR PRIMARY KEY,
                        reporter_id VARCHAR NOT NULL,
                        target_id VARCHAR NOT NULL,
                        reason VARCHAR NOT NULL
                    )
                    """.trimIndent(),
                )
            }
        }
    }

    @EventListener
    fun save(event: ReportCompleted) {
        val report = event.result
        DriverManager.getConnection(url, "sa", "").use { db ->
            db.prepareStatement(
                "INSERT INTO reports (report_id, reporter_id, target_id, reason) VALUES (?, ?, ?, ?)",
            ).use { statement ->
                statement.setString(1, report.reportId)
                statement.setString(2, report.reporterId)
                statement.setString(3, report.targetId)
                statement.setString(4, report.reason.name)
                check(statement.executeUpdate() == 1)
            }
        }
    }
}
