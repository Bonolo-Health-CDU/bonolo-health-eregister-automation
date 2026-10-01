package ls.gov.health.bonolo;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** The starter otherwise snapshots an empty profile rule set on a fresh database. */
@Configuration(proxyBeanMethods = false)
public class PackageBeforeValidation {
    @Bean
    public static BeanFactoryPostProcessor installContractBeforeBuildingValidationRules() {
        return factory -> {
            // Fail startup if a starter upgrade changes either bean name.
            factory.getBeanDefinition("packageInstaller");
            BeanDefinition validator = factory.getBeanDefinition("repositoryValidatingInterceptor");
            Set<String> dependencies = new LinkedHashSet<>();
            if (validator.getDependsOn() != null) {
                dependencies.addAll(Arrays.asList(validator.getDependsOn()));
            }
            dependencies.add("packageInstaller");
            validator.setDependsOn(dependencies.toArray(new String[0]));
        };
    }
}
