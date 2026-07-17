-- 1. Create the function with EXCEPTION handling
CREATE OR REPLACE FUNCTION public.on_store_created_setup_roles()
RETURNS TRIGGER AS $$
DECLARE
    v_template RECORD;
    v_role_id UUID;
    v_perm_name TEXT;
    v_perm_id UUID;
    v_has_templates BOOLEAN := false;
BEGIN
    FOR v_template IN SELECT * FROM public.platform_role_templates LOOP
        v_has_templates := true;
        
        INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, description)
        VALUES (
            NEW.id, 
            v_template.name, 
            INITCAP(v_template.name), 
            10, 
            TRUE, 
            FALSE, 
            'Auto-generated from template'
        )
        RETURNING id INTO v_role_id;

        IF v_template.permissions IS NOT NULL THEN
            FOR v_perm_name IN SELECT jsonb_array_elements_text(v_template.permissions) LOOP
                SELECT id INTO v_perm_id FROM public.permissions WHERE name = v_perm_name;
                
                IF v_perm_id IS NOT NULL THEN
                    INSERT INTO public.role_permissions (role_id, permission_id)
                    VALUES (v_role_id, v_perm_id)
                    ON CONFLICT DO NOTHING;
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    IF NOT v_has_templates THEN
        INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, description)
        VALUES (NEW.id, 'admin', 'Administrator', 1, TRUE, FALSE, 'Default store administrator')
        RETURNING id INTO v_role_id;

        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT v_role_id, id FROM public.permissions;
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Fallback: Ensure the store gets an admin role even if the loop fails
    -- We ignore further errors here to let the store creation succeed (Fail-safe)
    BEGIN
        INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, description)
        VALUES (NEW.id, 'admin', 'Administrator (Fallback)', 1, TRUE, FALSE, 'Fallback store administrator')
        RETURNING id INTO v_role_id;
        
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT v_role_id, id FROM public.permissions;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Create the trigger
DROP TRIGGER IF EXISTS trg_on_store_created_setup_roles ON public.stores;
CREATE TRIGGER trg_on_store_created_setup_roles
AFTER INSERT ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.on_store_created_setup_roles();
