package com.example.assetupgrade.hidden;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import javax.sql.DataSource;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;
import static com.example.assetupgrade.hidden.EngineeringProjectAccess.*;

/** Same ten behavior criteria across native project APIs. No production fixes. */
class FullEngineeringHiddenTest {
    private EngineeringProjectAccess project() throws Exception { return new EngineeringProjectAccess(); }
    private static JdbcDataSource source() {
        JdbcDataSource source=new JdbcDataSource();
        source.setURL("jdbc:h2:mem:coverage_"+UUID.randomUUID().toString().replace("-","")+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        source.setUser("sa");return source;
    }
    private static Map<String,String> record(String status) {return Map.of("status",status,"description","quoted ' 中文");}
    private static void rejected(Attempt attempt) { rejected(attempt,"Expected rejection"); }
    private static void rejected(Attempt attempt,String reason) {
        Exception ex=assertThrows(Exception.class,attempt::run,reason);
        String name=ex.getClass().getSimpleName();
        assertTrue(ex instanceof IllegalArgumentException || ex instanceof SecurityException || name.equals("ValidationException") || name.equals("TenantAccessException"),
            "Expected validation/security rejection, not missing API or infrastructure error: "+ex);
    }
    @Test
    void configurationMergesOverridesWithoutMutatingDefaults() throws Exception {
        Map<String,String> defaults=new HashMap<>(Map.of("environment","local","retry.maximumAttempts","3"));
        Map<String,String> overrides=new HashMap<>(Map.of("retry.maximumAttempts","7","tenant.name","研发"));
        Map<String,String> result=project().configuration(defaults,overrides);
        assertEquals(Map.of("environment","local","retry.maximumAttempts","7","tenant.name","研发"),result);
        assertEquals(Map.of("environment","local","retry.maximumAttempts","3"),defaults);
        assertEquals(Map.of("retry.maximumAttempts","7","tenant.name","研发"),overrides);
    }
    @Test
    void configurationRejectsInvalidRetryStorageAndEnvironment() throws Exception {
        EngineeringProjectAccess project=project();
        Map<String,String> valid=Map.of("environment","local","retry.maximumAttempts","3","attachment.maximumBytes","4096");
        assertDoesNotThrow(()->project.validate(valid));
        for(var invalid:Map.of("environment","","retry.maximumAttempts","-1","attachment.maximumBytes","0").entrySet()) {
            Map<String,String> request=new HashMap<>(valid);request.put(invalid.getKey(),invalid.getValue());
            rejected(()->{project.validate(request);return null;},"Invalid configuration accepted: "+invalid.getKey());
        }
    }
    @Test
    void jdbcRepositorySurvivesRecreationAndIsolatesIdenticalTenantKeys() throws Exception {
        EngineeringProjectAccess project=project();JdbcDataSource source=source();
        var first=project.repository(source,null);
        project.save(first,"tenant-a","order-1","ACCEPTED");project.save(first,"tenant-b","order-1","ROLLED_BACK");
        JdbcDataSource second=new JdbcDataSource();second.setURL(source.getURL());second.setUser("sa");
        var reopened=project.repository(second,null);
        assertEquals(record("ACCEPTED"),project.find(reopened,"tenant-a","order-1"));
        assertEquals(record("ROLLED_BACK"),project.find(reopened,"tenant-b","order-1"));
        assertPersistedRows(source);
        project.delete(reopened,"tenant-a","order-1");
        assertNull(project.find(reopened,"tenant-a","order-1"));assertEquals(record("ROLLED_BACK"),project.find(reopened,"tenant-b","order-1"));
    }
    private static void assertPersistedRows(DataSource source) throws Exception {
        try(var connection=source.getConnection();var tables=connection.getMetaData().getTables(null,null,"%",new String[]{"TABLE"})) {
            boolean hasRows=false;String quote=connection.getMetaData().getIdentifierQuoteString().trim();
            while(tables.next()) {
                String schema=tables.getString("TABLE_SCHEM");if("INFORMATION_SCHEMA".equalsIgnoreCase(schema))continue;
                String name=tables.getString("TABLE_NAME");
                String table=(schema==null?"":quote+schema.replace(quote,quote+quote)+quote+".")+quote+name.replace(quote,quote+quote)+quote;
                try(var statement=connection.createStatement();var rows=statement.executeQuery("SELECT COUNT(*) FROM "+table)){if(rows.next()&&rows.getLong(1)>0)hasRows=true;}
            }
            assertTrue(hasRows,"Production JDBC repository must persist data in a real database");
        }
    }
    @Test
    void jdbcTransactionRollsBackAllWritesAndCommitsSuccess() throws Exception {
        EngineeringProjectAccess project=project();DataSource source=source();var tx=project.transaction(source);var repo=project.repository(source,tx);
        project.save(repo,"tenant-a","existing","COMMITTING");
        assertThrows(IllegalStateException.class,()->tx.inTransaction(()->{
            try{project.save(repo,"tenant-a","existing","ACCEPTED");project.save(repo,"tenant-a","new","ROLLED_BACK");}
            catch(Exception e){throw new AssertionError(e);}
            throw new IllegalStateException("controlled business failure");
        }));
        assertEquals(record("COMMITTING"),project.find(repo,"tenant-a","existing"),"Failed transaction changed the existing record");
        assertNull(project.find(repo,"tenant-a","new"),"Failed transaction left the inserted record behind");
        var reopened=project.repository(source,null);
        assertEquals(record("COMMITTING"),project.find(reopened,"tenant-a","existing"));assertNull(project.find(reopened,"tenant-a","new"));
        assertEquals("committed",tx.inTransaction(()->{try{project.save(repo,"tenant-a","new","ACCEPTED");}catch(Exception e){throw new AssertionError(e);}return "committed";}));
        assertEquals(record("ACCEPTED"),project.find(reopened,"tenant-a","new"));assertPersistedRows(source);
    }
    @Test
    void messageSerializationPreservesIdentityUnicodeAndEscapes() throws Exception {
        project().serialization(Map.of("eventId","evt-1","tenantId","租户-A","correlationId","corr-1","payload","quote \" slash \\ newline\n tab\t"));
    }
    @Test
    void routeFilterRejectsDisabledAndCrossTenantRoutes() throws Exception {
        EngineeringProjectAccess project=project();
        assertTrue(project.route("tenant-a",true,"tenant-a"));assertFalse(project.route("tenant-b",true,"tenant-a"));
        assertFalse(project.route("tenant-a",false,"tenant-a"));assertFalse(project.route(null,true,"tenant-a"));
    }
    @Test
    void tenantBoundaryRejectsForeignAndEmptyResourceScope() throws Exception {
        EngineeringProjectAccess project=project();assertDoesNotThrow(()->project.boundary("tenant-a","tenant-a"));
        rejected(()->{project.boundary("tenant-a","tenant-b");return null;});rejected(()->{project.boundary("","");return null;});
    }
    @Test
    void metricsAggregateWithinTenantWithoutLeakingAnotherTenant() throws Exception {
        EngineeringProjectAccess project=project();Object metrics=project.metrics();
        project.increment(metrics,"tenant-a",2);project.increment(metrics,"tenant-a",3);project.increment(metrics,"tenant-b",9);
        assertEquals(5,project.counter(metrics,"tenant-a"));assertEquals(9,project.counter(metrics,"tenant-b"));assertEquals(0,project.counter(metrics,"tenant-c"));
    }
    @Test
    void readinessRequiresEveryDependencyAndDoesNotInventHealthyState() throws Exception {
        EngineeringProjectAccess project=project();
        assertTrue(project.ready(Map.of("database",true,"queue",true,"storage",true)));
        assertFalse(project.ready(Map.of("database",true,"queue",false,"storage",true)));
        assertFalse(project.ready(Map.of("database",false,"queue",true)));assertFalse(project.ready(Map.of()));
    }
    @Test
    void localCompositionExposesAllFourServicesAndStartupCompletes() throws Exception {
        EngineeringProjectAccess project=project();Object local=project.local();assertNotNull(local);
        List<Object> services=project.services(local);assertEquals(4,services.size());
        String[] operations={"intake","deliver","run","submit"};
        for(int i=0;i<services.size();i++){Object service=services.get(i);assertNotNull(service);assertTrue(has(service.getClass(),operations[i],1),"Service must expose its business operation: "+operations[i]);}
        List<String> command=new ArrayList<>(List.of(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),PKG+"AssetUpgradeGateway"));
        if(project.profile==21)command.add("--defaults");
        Path log=java.nio.file.Files.createTempFile("engineering-startup-",".log");
        Process process=new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {assertTrue(process.waitFor(15,TimeUnit.SECONDS),"Local startup did not finish within 15 seconds");assertEquals(0,process.exitValue(),java.nio.file.Files.readString(log));}
        finally {if(process.isAlive())process.destroyForcibly();java.nio.file.Files.deleteIfExists(log);}
    }
}
